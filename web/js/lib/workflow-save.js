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

/** True when the active workflow has never been persisted to disk (a temporary /
 *  unsaved tab), so grounding must save it. Mirrors saveActiveWorkflow's
 *  `wasUnsaved` (isTemporary === true || isPersisted === false). */
export function needsGrounding(wf) {
  return !!wf && (wf.isPersisted === false || wf.isTemporary === true);
}

/** #330 — decide whether to ground (auto-save) the active workflow BEFORE an agent
 *  turn. Grounding must run on EVERY turn that targets an unsaved tab, not only a
 *  brand-new chat: continuing an existing chat inside an unsaved tab still leaves
 *  the user's edits unprotected until they hit disk. `freshChat` is accepted (the
 *  call site has it) but is DELIBERATELY NOT a factor — a future change that
 *  reintroduces a fresh-chat-only gate would flip this contract and fail its test. */
export function shouldGroundBeforeTurn(wf, { freshChat } = {}) {
  void freshChat; // intentionally ignored — grounding is per-turn, see #330
  return needsGrounding(wf);
}

/** #330 safety gate: is a per-turn grounding SAVE actually safe to perform?
 *
 *  needsGrounding() trusts the in-memory `isTemporary`/`isPersisted` flags, but
 *  `isTemporary` DRIFTS true for a workflow already on disk after an open-ack race
 *  (#215/#226). Grounding once per fresh chat made that a rare edge; grounding on
 *  EVERY turn (#330) would repeatedly reach saveActiveWorkflow's in-place branch and
 *  overwrite a REAL file with the current (possibly mid-load) canvas. So authorize a
 *  per-turn save only when the source is PROVABLY never-persisted — mirroring
 *  classifySource's tri-state proof — via an async disk oracle
 *  `existsOnDisk(rawPath) => true | false | null`:
 *    - isPersisted === true              → false (genuinely saved; never auto-ground)
 *    - no backing path                   → true  (brand-new tab, nothing to lose)
 *    - oracle proves ABSENT (404)        → true
 *    - oracle proves PRESENT / unknown   → false (fail safe — the user can Ctrl+S)
 *  With no usable oracle we can prove nothing → false (refuse), never a blind save. */
export async function groundingIsSafe(wf, existsOnDisk) {
  if (!wf) return false;
  if (wf.isPersisted === true) return false;
  const raw = wf.path;
  if (!raw) return true; // no path at all ⇒ nothing on disk to lose
  if (typeof existsOnDisk !== "function") return false; // cannot prove ⇒ refuse
  let exists = null;
  try {
    exists = await existsOnDisk(raw);
  } catch {
    exists = null; // probe failed ⇒ unknown ⇒ refuse
  }
  return exists === false; // ONLY a proven absence authorizes the save
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
export async function saveActiveWorkflow(
  svc,
  name,
  { autoWorkflowName, existsOnDisk, reconcileSavedCopy } = {},
) {
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

    // #309 — classify a filename COLLISION at the resolved target BEFORE invoking any
    // save/copy API. Combines two oracles: a PERSISTED workflow already indexed at the
    // target (store), and the authoritative /userdata disk probe. States:
    //   "exists"    — a real workflow already occupies the target → refuse now, so
    //                 NOTHING is mutated (no rebind, no copy, no overwrite prompt);
    //   "absent"    — the disk oracle proved the target free → safe to proceed;
    //   "unknown"   — an oracle was present but could not confirm (probe threw / a
    //                 non-conclusive status) → AMBIGUOUS;
    //   "no-oracle" — no disk oracle at all (older frontend / test) → legacy path.
    const targetState = await probeTargetCollision(svc, wf, finalTargetPath, existsOnDisk);
    if (targetState === "exists") {
      throw conflictError(effectiveName);
    }

    // #285 — EXTERNAL source: a real file loaded from an ABSOLUTE path OUTSIDE the
    // managed workflows dir (panel_load_workflow path:<file>). Two hazards make the
    // normal copy path unsafe here: (a) /userdata cannot prove/relocate an external
    // path, so the disk oracle can't classify it; and (b) the high-level
    // saveWorkflowAs writes into the source's own (unwritable) directory and MOVES
    // a temporary — either would misplace or DESTROY the external original (#226).
    // So copy the CURRENT graph into the USER workflows dir via the move-free,
    // explicit-target low-level copy (saveAs + openWorkflow + saveWorkflow), which
    // never references the source's on-disk file. If that copy API is unavailable,
    // REFUSE rather than risk moving the external original.
    if (isExternalWorkflowPath(sourcePath)) {
      const copyToUserDir = resolveSaveAsCopy(svc, { reconcileSavedCopy });
      if (!copyToUserDir) {
        throw new Error(
          "save-as (copy) is unavailable on this frontend for an externally-loaded workflow; " +
            "refusing to move or destroy the original file outside the workflows folder (issue #285/#226)",
        );
      }
      return await withConflictRollback(svc, wf, effectiveName, finalTargetPath, () =>
        copyToUserDir(wf, effectiveName, finalTargetPath),
      );
    }

    const cls = await classifySource(svc, wf, sourcePath, existsOnDisk);

    // #226 CLASSIFICATION GUARD (hoisted so it applies regardless of which copy API
    // is used) — a source ACTING temporary that isn't PROVABLY never-persisted must
    // not be relocated: it might be a real on-disk file a relocate could move or
    // destroy. This is about the SOURCE, not the write mechanism. A correctly-opened
    // persisted workflow (isTemporary === false) hits the copy path below.
    if (wf.isTemporary === true && cls !== "never-persisted") {
      throw new Error(
        `refusing to save: the active workflow is flagged unsaved but its source "${sourcePath}" ` +
          `${cls === "persisted" ? "exists on disk" : "cannot be proven absent from disk"} — ` +
          `saving now could MOVE (destroy) the original (issue #226). Re-open the workflow and try again.`,
      );
    }

    // #226/#309 P1-1 — a relocating Save-As can COLLIDE with an existing file, and a
    // non-atomic HEAD pre-check can NEVER make an OVERWRITING write safe (a target can
    // appear between the check and the write — TOCTOU). So the ONLY sanctioned write is
    // the low-level trio: saveAs builds an explicit-target copy and saveWorkflow
    // persists it with overwrite:false, which asks the server NOT to overwrite an
    // existing target and never prompts/deletes. This is the route the real 1.47.x
    // frontend exposes.
    //
    // ACCEPTED UPSTREAM LIMITATION (documented, not fixable from the panel): ComfyUI's
    // /userdata POST is NOT exclusive-create — user_manager.py does
    // `os.path.exists(target)` → `await request.read()` → `os.replace(tmp, target)`,
    // and neither the server nor the frontend `storeUserData` exposes an
    // exclusive-create/no-replace/conditional flag (only the boolean `overwrite`
    // query). So a target CREATED during the server's request-body-read await gap is
    // silently overwritten (200, not 409). We do everything a client CAN — store+disk
    // pre-check, a final SYNCHRONOUS re-check immediately before saveAs, the atomic
    // trio only, no prompting/deleting API — and POST-WRITE DETECTION (below) that
    // reads the target back and verifies it is OUR content, converting a silent
    // clobber-of-our-write into a surfaced error. The user's OWN original is never
    // touched. The residual (a concurrent save to the identical brand-new name within
    // that sub-second window, which cannot occur in a single-user session, and cannot
    // retroactively protect a victim file the server already replaced) is upstream-only.
    const atomicCopy = resolveSaveAsCopy(svc, { reconcileSavedCopy });
    if (atomicCopy) {
      const activeName = await withConflictRollback(svc, wf, effectiveName, finalTargetPath, () =>
        atomicCopy(wf, effectiveName, finalTargetPath),
      );
      // BACKSTOP: if the copy somehow relocated a persisted source, fail LOUDLY
      // rather than report a phantom success (#226).
      if (cls === "persisted" && confirmedAbsentAt(svc, sourcePath)) {
        throw new Error(
          `save moved the original workflow "${sourcePath}" instead of copying it — ` +
            `the source no longer exists on disk (issue #226)`,
        );
      }
      return activeName;
    }

    // No atomic low-level copy trio. Every remaining relocation mechanism is unsafe:
    //  - the high-level `saveWorkflowAs` writes by PROMPTING and can DELETE+overwrite
    //    an existing target (an unavoidable TOCTOU + data-loss #226/#309 P1-1); and
    //  - a `renameWorkflow` fallback MOVES the workflow and cannot be made atomic
    //    against a target appearing between the HEAD probe and the write (a 409 on
    //    the follow-up save would strand the tab rekeyed at the conflicting path).
    // The real frontend always exposes the atomic saveAs/openWorkflow/saveWorkflow
    // trio, so REFUSE rather than route a collision-capable Save-As through an unsafe
    // path. (This never blocks a genuine 1.47.x frontend; it only refuses a build
    // that offers no safe copy API.)
    throw new Error(
      "atomic Save-As (copy) is unavailable on this frontend — it exposes no safe " +
        "saveAs/openWorkflow/saveWorkflow copy API, and the alternatives (prompting " +
        "saveWorkflowAs / renameWorkflow) can overwrite or strand a workflow; refusing to " +
        "rename and destroy the original workflow (issue #226/#309). Update ComfyUI.",
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

/** Resolve the frontend's ATOMIC Save-As (COPY) capability into a single async
 *  adapter `(wf, effectiveName, finalTargetPath) => resolvedActiveName`, or null
 *  when the atomic trio is unavailable.
 *
 *  ONLY the low-level trio is offered — `saveAs(wf, path)` builds a NEW copy object
 *  at an explicit `path` (source object + file untouched), `openWorkflow` loads its
 *  graph, and `saveWorkflow(copy)` persists it with overwrite:false (asks the server
 *  not to overwrite an existing target; NO prompt/delete). This is a genuine COPY
 *  (never moves/destroys the source, #226).
 *
 *  The high-level `saveWorkflowAs` is DELIBERATELY NOT used: it writes by prompting
 *  and can DELETE+overwrite an existing target, which no pre-check can make safe.
 *  The caller refuses a collision-capable Save-As when only that API exists.
 *
 *  `reconcileSavedCopy(targetPath, copy)` is an OPTIONAL authoritative read-back
 *  oracle → "ours" | "foreign" | "absent" | "unknown". It backs two guards the
 *  server's non-exclusive-create /userdata write demands:
 *   - AMBIGUOUS post-commit failure (P2): a persist can COMMIT to disk and THEN
 *     reject while receiving/parsing the response (connection reset / resp.json()
 *     error — the frontend updates persisted metadata only AFTER parsing). Blindly
 *     removing the copy on every rejection would ORPHAN the on-disk file. On a
 *     NON-conflict failure we reconcile: if the target holds OUR content the write
 *     landed → ADOPT the copy (never orphan) and report success.
 *   - POST-WRITE CLOBBER DETECTION (P0): after a "successful" persist, verify the
 *     target still holds OUR content; a concurrent save in the server's body-read
 *     window can silently overwrite it (200, not 409) → surface a detected error
 *     instead of a false success. */
function resolveSaveAsCopy(svc, { reconcileSavedCopy } = {}) {
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
      // FINAL, SYNCHRONOUS collision re-check IMMEDIATELY before saveAs — this closes
      // the TOCTOU window between probeTargetCollision's async disk HEAD and this
      // write: another unsaved tab may have occupied the target WHILE the HEAD was
      // pending, and the real store's saveAs unconditionally REPLACES the lookup
      // entry (orphaning that tab's unsaved graph, a data loss #226). No `await`
      // separates this check from the synchronous saveAs below, so it is atomic.
      //
      // It FAILS CLOSED: if the store lookup is absent or THROWS we cannot prove the
      // target is free, so we refuse rather than risk overwriting an in-memory tab
      // (the real 1.47 store always exposes getWorkflowByPath — it is a REQUIRED
      // member — so this never blocks a genuine frontend).
      if (typeof svc.getWorkflowByPath !== "function") {
        throw new Error(
          `save-as (copy) cannot verify the target "${finalTargetPath}" is free on this frontend ` +
            `(no workflow lookup) — refusing to avoid overwriting an in-memory tab (#226).`,
        );
      }
      let occupant;
      try {
        occupant = svc.getWorkflowByPath(finalTargetPath);
      } catch {
        throw new Error(
          `save-as (copy) could not verify the target "${finalTargetPath}" is free (workflow ` +
            `lookup failed) — refusing to avoid overwriting an in-memory tab (#226). Retry.`,
        );
      }
      if (occupant && occupant !== wf) {
        const err = new Error(
          `a workflow already occupies "${finalTargetPath}" (409 Conflict) — choose a different name`,
        );
        err.status = 409;
        throw err;
      }
      // saveAs builds the copy in memory at the resolved target path (source
      // object untouched); the source's on-disk file is never referenced, so it
      // cannot be moved/destroyed (#226).
      const copy = svc.saveAs(wf, finalTargetPath);
      // STAMP a stable, proxy-safe token on OUR copy. The real store inserts the raw
      // object into a reactive `workflowLookup`, and reading it back via
      // getWorkflowByPath returns Vue's REACTIVE PROXY — which is NOT `===` the raw
      // object. So later cleanup must identify "our copy" by this token (which reads
      // through the proxy) rather than object identity, or the purge silently no-ops.
      stampCopyToken(copy);
      if (!copy) {
        throw new Error("save-as (copy) failed to create a copy on this frontend");
      }
      // Mirror the frontend's own Save-As sequence: OPEN/activate the copy
      // (loads the graph into changeTracker/activeState, makes it active), THEN
      // persist — so save() writes the real graph, not null. A throw here aborts
      // BEFORE any saveWorkflow, so a failed open never persists null.
      const prevActive = svc.activeWorkflow;
      const resolvedName = () =>
        baseName(svc.activeWorkflow?.filename) || baseName(copy.filename) || effectiveName;
      try {
        await svc.openWorkflow(copy);
        copy.changeTracker?.prepareForSave?.();
        await svc.saveWorkflow(copy);
      } catch (err) {
        // P2 — distinguish a CONFIRMED pre-commit failure (409 conflict, or the
        // target is provably absent afterward → the server wrote nothing) from an
        // AMBIGUOUS post-commit failure (the persist COMMITTED to disk, then the
        // response was lost/failed to parse). Blindly removing the copy on ambiguity
        // ORPHANS the on-disk file (a later retry then 409s). So on a NON-conflict
        // failure, RECONCILE by reading the target back:
        if (!isConflictError(err) && typeof reconcileSavedCopy === "function") {
          let state = "unknown";
          try {
            state = await reconcileSavedCopy(finalTargetPath, copy);
          } catch {
            state = "unknown";
          }
          if (state === "ours") {
            // The write LANDED despite the failed response — the workflow IS saved.
            // Adopt the copy (never orphan it) and mark it PERSISTED by updating the
            // REAL backing field the store's getters derive from: on 1.47 `isTemporary`
            // and `isPersisted` are GETTER-ONLY (isTemporary === size===-1), so
            // assigning them is a silent no-op — we must set `size`. Without this the
            // adopted copy stays "temporary": a later in-place Save uses overwrite:false
            // and 409s, and closing the tab takes the temporary-purge path (dropping the
            // saved copy). markCopyPersisted sets size + resyncs originalContent so the
            // store treats it as a normal saved, unmodified workflow. Report success.
            markCopyPersisted(copy);
            return resolvedName();
          }
          if (state === "foreign") {
            // The target holds SOMEONE ELSE's content — our write was clobbered or
            // never landed. Remove our orphan, restore active, and surface a
            // clobber-aware error (never a false success).
            removeInMemoryWorkflow(svc, copy);
            if (prevActive !== undefined) svc.activeWorkflow = prevActive;
            throw new Error(
              `save-as could not save "${finalTargetPath}": the target now holds a DIFFERENT ` +
                `workflow (a concurrent save clobbered it). Retry with a new name (#226).`,
            );
          }
          // "absent"/"unknown" ⇒ the write did not land (or can't be confirmed) ⇒
          // fall through to the safe removal below.
        }
        removeInMemoryWorkflow(svc, copy);
        if (prevActive !== undefined) svc.activeWorkflow = prevActive;
        throw err;
      }
      // SUCCESS-PATH BOOKKEEPING (#309 P1, mirror of the adoption branch). ComfyUI's own
      // saveWorkflow(copy) captures copy.content, awaits the write, THEN calls
      // changeTracker.reset() (re-baselining to the LIVE canvas) and forces
      // isModified=false. If the user edited the graph DURING the successful save await,
      // the live canvas advanced past what committed (disk holds S1, canvas is S2), so
      // upstream marks the copy "clean" at S2 while S2 is UNSAVED — workflow_close then
      // silently unloads it (data loss). Re-run our committed-vs-live bookkeeping to
      // OVERRIDE that: baseline to the COMMITTED snapshot (copy.content) and set
      // isModified DIRECTLY on OUR copy (never path-resolving). Identical to upstream
      // when no edit occurred; strictly more correct when an in-flight edit happened.
      markCopyPersisted(copy);
      // P0 — POST-WRITE CLOBBER DETECTION. The server's overwrite:false is NOT
      // exclusive-create (os.path.exists → await body-read → os.replace), so a target
      // created during the body-read window is silently overwritten (200, not 409).
      // After a reported-success persist, verify the target still holds OUR content;
      // if not, a concurrent save clobbered ours → surface a detected error rather
      // than a false success. (This detects a clobber OF our write; it cannot
      // retroactively protect a victim file the server already replaced — that is
      // upstream-only. Best-effort: "unknown" leaves the reported success intact.)
      if (typeof reconcileSavedCopy === "function") {
        let state = "unknown";
        try {
          state = await reconcileSavedCopy(finalTargetPath, copy);
        } catch {
          state = "unknown";
        }
        if (state === "foreign" || state === "absent") {
          // The copy is currently ACTIVE and (from the reported-success persist) would
          // read as PERSISTED, but the on-disk target is proven NOT ours. Leaving the
          // tab bound to it is itself a data-loss setup: a later plain Save (no new
          // name) takes the in-place branch, and ComfyUI's persisted save uses
          // overwrite:this.isPersisted → it would SILENTLY OVERWRITE the foreign file.
          // So IDENTITY-SAFELY remove our copy and restore the previously-active
          // workflow BEFORE surfacing the error — never retain ownership of a target
          // we just proved isn't ours (#226).
          removeInMemoryWorkflow(svc, copy);
          if (prevActive !== undefined) svc.activeWorkflow = prevActive;
          throw new Error(
            `save-as reported success but "${finalTargetPath}" does not contain the saved ` +
              `workflow — a concurrent save clobbered it (ComfyUI's /userdata write is not ` +
              `exclusive-create). Retry with a new name (#226).`,
          );
        }
      }
      return resolvedName();
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

/** The managed user workflows root — the only directory ComfyUI's /userdata API
 *  can write to. Store paths are always relative under it ("workflows/…"). */
const WORKFLOWS_ROOT = "workflows";

/** True when `path` is an ABSOLUTE filesystem path — a Windows drive ("C:\\", "C:/"),
 *  a UNC share ("\\\\server"), or a POSIX absolute ("/…"). Such a path is a workflow
 *  loaded from OUTSIDE the managed workflows dir (panel_load_workflow path:<file>);
 *  it can never be a /userdata store path, so a Save-As of it must copy into the
 *  user workflows dir rather than the unwritable external directory (#285). Only
 *  absolute paths qualify — a relative "workflows/…" store path is never external,
 *  so the everyday save path is untouched. */
function isExternalWorkflowPath(path) {
  const raw = String(path || "");
  if (!raw) return false;
  return /^[a-zA-Z]:[\\/]/.test(raw) || /^[\\/]{2}/.test(raw) || /^\//.test(raw);
}

/** Directory prefix (with trailing slash) that a new sibling file should live in,
 *  preserving the workflow's containing folder. An EXTERNAL (absolute) source
 *  directory is unwritable via /userdata, so its Save-As copy is redirected to the
 *  user workflows root (#285). Defaults to the workflows root. */
function directoryOf(wf) {
  const dir = String(wf?.directory || "").replace(/[\\/]+$/, "");
  if (!dir || isExternalWorkflowPath(dir)) return `${WORKFLOWS_ROOT}/`;
  return `${dir}/`;
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

/** True when `err` is a name-collision (HTTP 409) from the userdata write — the
 *  target filename already exists on disk (#309). Recognised by an explicit
 *  status field or the conflict wording ComfyUI's /userdata surfaces. */
function isConflictError(err) {
  if (!err) return false;
  const status = err.status ?? err.statusCode ?? err.response?.status;
  if (status === 409) return true;
  const msg = String(err?.message ?? err).toLowerCase();
  return msg.includes("409") || msg.includes("conflict") || msg.includes("already exists");
}

/** The clean, uniform filename-conflict error surfaced by both the pre-check and
 *  the post-write rollback (#309). */
function conflictError(desiredName) {
  const nm = baseName(desiredName) || "that name";
  return new Error(
    `a workflow named "${nm}" already exists (409 Conflict) — choose a different name. ` +
      `The active tab was left unchanged (issue #309).`,
  );
}

/** Assign `obj[key] = value` WITHOUT throwing. Real ComfyUI workflow objects expose
 *  DERIVED, getter-only flags (`get isTemporary(){return this.size===-1}`, etc.), and
 *  a plain assignment to those throws a TypeError under ES-module strict mode — which
 *  would replace the clean 409 and abort the rest of the rollback. Getter-only /
 *  frozen properties are silently skipped: they are computed from store state we do
 *  not restore here, so leaving them be is correct (restoring `path`/`filename` and
 *  the active reference is what un-strands the tab). */
function safeAssign(obj, key, value) {
  try {
    obj[key] = value;
  } catch {
    /* getter-only / non-writable — nothing to restore for a derived flag */
  }
}

/** Run a relocating save (`fn`) and, on a 409 filename CONFLICT that slips past the
 *  up-front pre-check (e.g. no disk oracle, or a TOCTOU race), ROLL BACK any
 *  optimistic in-memory rebind before surfacing a clean error (#309).
 *
 *  The frontend's saveWorkflowAs renames/rebinds the active tab to the target path
 *  BEFORE its server write; when that write 409s (name already exists) the tab was
 *  left stranded — bound to a file it can't own and flagged unsaved, which then
 *  tripped the #226 guard so it could no longer be saved under ANY other name
 *  without a manual rename. We snapshot the tab's identity + the active reference up
 *  front and, on a conflict, restore the ACTIVE REFERENCE FIRST (always settable),
 *  then best-effort restore the settable identity fields (`path`/`filename`), so
 *  panel_list_workflows shows the tab as it was and a re-save under a new name works.
 *  Derived getter-only flags are skipped via safeAssign so restoration never throws.
 *  A non-conflict error is rethrown untouched. Nothing on disk is modified here — a
 *  409 means the server wrote nothing, and the pre-existing file is never our source. */
async function withConflictRollback(svc, wf, desiredName, finalTargetPath, fn) {
  const prevActive = svc?.activeWorkflow;
  const snap = wf
    ? {
        path: wf.path,
        filename: wf.filename,
        key: wf.key,
        directory: wf.directory,
        isTemporary: wf.isTemporary,
        isPersisted: wf.isPersisted,
      }
    : null;
  try {
    return await fn();
  } catch (err) {
    if (!isConflictError(err)) throw err;
    // Restore the active reference FIRST — it is a plain store field and is the
    // load-bearing fix (the conflicting/copy tab must not remain active), so it
    // must happen even if a later field restore is a no-op. The low-level adapter
    // has already removed ITS OWN orphaned copy IDENTITY-SAFELY (it never evicts a
    // distinct late occupant), so there is no store-topology repair to do here.
    if (svc && prevActive !== undefined) svc.activeWorkflow = prevActive;
    if (wf && snap) {
      safeAssign(wf, "path", snap.path);
      safeAssign(wf, "filename", snap.filename);
      if ("key" in wf) safeAssign(wf, "key", snap.key);
      safeAssign(wf, "directory", snap.directory);
      safeAssign(wf, "isTemporary", snap.isTemporary);
      safeAssign(wf, "isPersisted", snap.isPersisted);
    }
    throw conflictError(desiredName);
  }
}

/** Tri/quad-state collision classification for the resolved Save-As target, used to
 *  pre-empt a destructive/overwriting save BEFORE any API call (#309). Returns
 *  "exists" (a workflow already occupies the target — via the store index or a 200
 *  from the disk oracle), "absent" (the disk oracle 404'd — provably free),
 *  "unknown" (an oracle was present but inconclusive — probe threw / ambiguous), or
 *  "no-oracle" (no disk oracle at all). The store check runs first so an occupied
 *  target is caught even when the disk probe is unavailable (the #309/P1-A repro). */
async function probeTargetCollision(svc, wf, finalTargetPath, existsOnDisk) {
  if (typeof svc?.getWorkflowByPath === "function") {
    try {
      const atTarget = svc.getWorkflowByPath(finalTargetPath);
      // ANY DISTINCT workflow object already at the target is a collision — PERSISTED
      // or TEMPORARY. The real 1.47 store's saveAs unconditionally REPLACES
      // workflowLookup[target] with the new copy; if an UNSAVED temporary tab already
      // owns the target path, that would orphan its graph (data loss). A disk 404
      // can't see an unsaved tab, so the store index is the only signal here — refuse
      // rather than overwrite it. (Never the source itself — a relocate targets a
      // different path — but guard `!== wf` for safety.)
      if (atTarget && atTarget !== wf) return "exists";
    } catch {
      /* store threw ⇒ no signal from this oracle */
    }
  }
  if (typeof existsOnDisk === "function") {
    let probe = null;
    try {
      probe = await existsOnDisk(finalTargetPath);
    } catch {
      probe = null; // oracle present but threw ⇒ ambiguous
    }
    if (probe === true) return "exists";
    if (probe === false) return "absent";
    return "unknown";
  }
  return "no-oracle";
}

/** IDENTITY-SAFE removal of a workflow copy from the store — used to undo an
 *  orphaned/clobbered copy tab (#309/#226). The IN-MEMORY record is dropped; the
 *  copy's on-disk file is NEVER deleted.
 *
 *  Two hazards this navigates:
 *   1. LATE OCCUPANT — the store's path-keyed removers (the real 1.47 `closeWorkflow`
 *      does `delete workflowLookup[wf.path]`) would evict WHATEVER occupies `wf.path`.
 *      If a DISTINCT late occupant claimed that path while we awaited, closing by path
 *      would delete IT. So path-keyed removal runs ONLY when the store lookup STILL
 *      points to `wf`; otherwise `wf` is spliced out of the open-tab arrays by
 *      IDENTITY and the occupant's lookup entry is left untouched.
 *   2. PERSISTED COPY LINGERS — ComfyUI 1.47's `closeWorkflow` deletes the lookup
 *      entry ONLY for a TEMPORARY workflow (`get isTemporary(){return size===-1}`); a
 *      PERSISTED one is merely `unload()`ed and its record STAYS in workflowLookup,
 *      where it would block a future Save-As to that name. When our copy is persisted
 *      (a reported-success write set its `size`), we COERCE it back to temporary
 *      (`size = -1`) BEFORE closing so `closeWorkflow`'s temporary branch fully purges
 *      the lookup — an IN-MEMORY-only change; `closeWorkflow` never touches disk. */
function removeInMemoryWorkflow(svc, wf) {
  if (!svc || !wf) return;
  // Proxy-safe "is this record OUR copy?": read the record's token (reflected
  // through Vue's reactive proxy) and compare to ours. Falls back to `===` only when
  // our copy carries no token (un-stamped callers/tests).
  const lookupIsOurs = () => {
    if (typeof svc.getWorkflowByPath !== "function") return null; // unknown
    try {
      return isSameCopy(wf, svc.getWorkflowByPath(wf.path));
    } catch {
      return null; // unknown
    }
  };
  // Does the store's path→object lookup still point at OUR copy?
  const stillOurs = lookupIsOurs() === true;
  if (stillOurs) {
    // Coerce to TEMPORARY so the store's path-keyed removal fully purges the lookup
    // entry even for a copy that a successful write marked persisted (#226). `size`
    // === -1 is the frontend's temporary marker; flipping it changes only the
    // in-memory record — the on-disk file is untouched by closeWorkflow.
    safeAssign(wf, "size", -1);
    safeAssign(wf, "isTemporary", true);
    safeAssign(wf, "isPersisted", false);
    if (typeof svc.closeWorkflow === "function") {
      try {
        svc.closeWorkflow(wf);
        if (lookupIsOurs() !== true) return; // purged (or unknown) ⇒ done
      } catch {
        /* fall through */
      }
    }
    if (typeof svc.removeWorkflow === "function") {
      try {
        svc.removeWorkflow(wf);
        if (lookupIsOurs() !== true) return;
      } catch {
        /* fall through */
      }
    }
  }
  // Identity-only cleanup: remove OUR object from the known list arrays. Match by the
  // proxy-safe token (the arrays may hold the REACTIVE PROXY, not the raw copy), so a
  // distinct occupant is never touched.
  for (const listName of ["openWorkflows", "workflows"]) {
    const list = svc[listName];
    if (Array.isArray(list)) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (isSameCopy(wf, list[i])) list.splice(i, 1);
      }
    }
  }
}

/** Structural (best-effort) equality of two graph states, via a stable JSON encode.
 *  Only a fallback for builds/doubles without ChangeTracker.updateModified. */
function stateContentEqual(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Mark an ADOPTED copy (whose write committed but whose response was lost, #309 P2)
 *  as a normal PERSISTED workflow — mirroring the bookkeeping a SUCCESSFUL saveWorkflow
 *  does. On ComfyUI 1.47 `isTemporary` / `isPersisted` are DERIVED getters (isTemporary
 *  === size===-1), so assigning them is a no-op — the REAL field is `size`.
 *
 *  For the MODIFIED flag the baseline MUST be the COMMITTED SNAPSHOT (what was written
 *  to disk — the content the write used, i.e. `copy.content`), NOT the current live
 *  activeState. A plain `changeTracker.reset()` re-baselines to activeState, which is
 *  WRONG when the user edited the graph DURING the save await: activeState advanced past
 *  what committed, so resetting-to-activeState marks that UNSAVED edit "clean" and
 *  workflow_close then silently UNLOADS it (data loss). Instead we set the tracker's
 *  baseline to the committed snapshot and RECOMPUTE isModified from (committed vs live
 *  activeState): clean iff the canvas still equals what was saved, else DIRTY — exactly
 *  what a real save leaves. All best-effort / getter-safe / in-memory only. */
function markCopyPersisted(copy) {
  if (!copy || typeof copy !== "object") return;
  try {
    if (copy.size === -1 || copy.size == null) {
      const len = typeof copy.content === "string" ? copy.content.length : 0;
      copy.size = len > 0 ? len : 1; // any non-(-1) value ⇒ isTemporary false
    }
  } catch {
    /* size not settable ⇒ best-effort */
  }
  try {
    if (typeof copy.content === "string") copy.originalContent = copy.content;
  } catch {
    /* best-effort */
  }
  // Baseline the change tracker to the COMMITTED SNAPSHOT, then recompute modified.
  try {
    const ct = copy.changeTracker;
    if (ct && typeof copy.content === "string") {
      let committed;
      try {
        committed = JSON.parse(copy.content);
      } catch {
        committed = undefined;
      }
      if (committed !== undefined) {
        ct.initialState = committed; // baseline := the SAVED snapshot (not live activeState)
        // Set isModified DIRECTLY on OUR copy — do NOT call ct.updateModified(), which on
        // 1.47 RE-RESOLVES the workflow by `this.workflow.path` and writes isModified on
        // whatever object occupies that path. A distinct late occupant that claimed the
        // path during the reconcile await would be wrongly marked clean → workflow_close
        // could then unload ITS unsaved graph (#226). Compute clean = (committed baseline
        // equals live activeState) using the frontend's own graphEqual when reachable
        // (via the tracker class) for precision, else a JSON structural compare — but
        // only when we actually have a live activeState to compare against.
        if (ct.activeState !== undefined) {
          const graphEqual =
            typeof ct.constructor?.graphEqual === "function" ? ct.constructor.graphEqual : null;
          let clean;
          try {
            clean = graphEqual
              ? graphEqual(committed, ct.activeState)
              : stateContentEqual(committed, ct.activeState);
          } catch {
            clean = stateContentEqual(committed, ct.activeState);
          }
          safeAssign(copy, "isModified", !clean);
        }
      }
    }
  } catch {
    /* best-effort */
  }
  safeAssign(copy, "isPersisted", true);
  safeAssign(copy, "isTemporary", false);
}

// A stable, proxy-safe token stamped on each Save-As COPY so later cleanup can
// identify "our copy" even when the store returns a Vue reactive PROXY (which is not
// `===` the raw object). Reading the token through the proxy reflects the raw value.
const COPY_TOKEN_KEY = "__cmcpSaveCopyToken";
let copyTokenCounter = 0;
function stampCopyToken(copy) {
  if (!copy || typeof copy !== "object") return;
  try {
    // Non-enumerable so it never leaks into spreads/Object.keys/serialization. (The
    // workflow's disk content is serialized from changeTracker.activeState, not this
    // object, so a token here can never reach disk regardless.)
    Object.defineProperty(copy, COPY_TOKEN_KEY, {
      value: `cmcp-copy-${Date.now()}-${++copyTokenCounter}`,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    /* frozen/sealed ⇒ token-less; isSameCopy falls back to === */
  }
}

/** True when `candidate` (possibly a reactive proxy read back from the store) is OUR
 *  copy `wf`. Prefers the stable stamped token (reflected through the proxy); falls
 *  back to object identity only when `wf` carries no token. Never matches a distinct
 *  record that lacks our token. */
function isSameCopy(wf, candidate) {
  if (!candidate) return false;
  let token;
  try {
    token = wf?.[COPY_TOKEN_KEY];
  } catch {
    token = undefined;
  }
  if (token != null) {
    try {
      return candidate[COPY_TOKEN_KEY] === token;
    } catch {
      return false;
    }
  }
  return candidate === wf; // fallback: un-stamped copy
}
