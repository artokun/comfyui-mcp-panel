// Programmatic workflow saving — shared by the panel and unit tests.
//
// #442 defect 3 — the in-place-overwrite gate compares the on-disk file's RAW BYTES
// against a canonical UTF-8 encoding of the tab's loaded baseline text, so a BOM (or any
// byte-level) difference a decoded-string compare would miss cannot authorize a
// destructive overwrite. See diskBytesEqualText for why raw bytes are required.
import { diskBytesEqualText } from "./workflow-open-staleness.js";

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

/** Map the AUTHORITATIVE save outcome that `saveActiveWorkflow` reports (via its
 *  optional `details` sink) into the tool-result fields, so `panel_save_workflow`
 *  no longer returns the opaque `{saved:true}` (mcp#579's "at minimum (2)": a
 *  silent rename-vs-copy is what made the bug unrecoverable). This is a PURE
 *  mapper over the mode saveActiveWorkflow DECIDED — NOT an after-the-fact guess
 *  from the (mutable, race-prone) active workflow — so it can never be fooled by
 *  a tab switch during the save await.
 *
 *  `details.mode`:
 *   - "save-as-copy" → a NEW file was written from a REAL existing source (an
 *     already-persisted workflow OR an externally-loaded file, #285) which stays
 *     put ⇒ `{ saved_as: true, copied_from }`. The caller then disk-verifies the
 *     source path and stamps `original_on_disk` (a disk claim must be disk-checked).
 *   - "first-save"   → a never-persisted temp / new_workflow tab got its first real
 *     name+file; there is no prior file to preserve (panel#363) ⇒ `{ first_save: true }`.
 *   - "in-place" / anything else → same-path overwrite or no-name grounding ⇒ `{}`. */
export function describeSaveOutcome(details = {}) {
  const mode = details?.mode;
  if (mode === "save-as-copy") {
    return { saved_as: true, copied_from: baseName(details.copiedFrom) || null };
  }
  if (mode === "first-save") {
    return { first_save: true };
  }
  return {};
}

/** Decide what to report about a Save-As COPY's ORIGINAL source file from two disk
 *  probes, and — critically — WHEN a missing source is a genuine data-loss event vs
 *  a benign "never existed / can't tell". Pure + total, so the panel's throw decision
 *  is unit-testable and can never fire on a transient/indeterminate classification.
 *
 *  A data-loss THROW ("lost") requires POSITIVE prior evidence the source existed —
 *  a CONFIRMED pre-save 200 (`preExisted === true`) that is now a CONFIRMED 404
 *  (`postExists === false`). Every weaker combination degrades to "unverified":
 *   - `preExisted` unknown/false (the source was never proven present — e.g. a
 *     non-temporary yet never-persisted tab whose classification was `unknown`, or a
 *     phantom "workflows/Unsaved Workflow.json" that 404s simply because it never
 *     existed) ⇒ NEVER throw, even if postExists is false;
 *   - `postExists` true ⇒ "present";
 *   - anything else (post probe inconclusive) ⇒ "unverified".
 *  This closes a false data-loss throw on a legitimate first save and avoids blaming
 *  this Save-As for an unrelated deletion we cannot attribute to it. */
export function classifyOriginalOnDisk({ preExisted, postExists } = {}) {
  if (preExisted === true && postExists === false) return "lost";
  if (postExists === true) return "present";
  return "unverified";
}

/** Map a /userdata HEAD status to the tri-state existence oracle used everywhere a
 *  save decision is made. Deliberately STRICT: ONLY `200` is positive proof a file is
 *  present; `404` is proof of absence; ANY other status — including a non-200 2xx a
 *  proxy/intermediary might return (204/206/…), a redirect, or a 5xx — is INDETERMINATE
 *  (null), never "present". A loose `res.ok` (200–299) mapping let a 2xx-non-200
 *  pre-save probe count as a confirmed 200, which — paired with a real 404 later —
 *  produced a FALSE "lost" data-loss verdict. Both the pre- and post-save existence
 *  probes flow through this, so the "confirmed 200" the data-loss gate requires is a
 *  true 200. */
export function diskExistenceFromStatus(status) {
  if (status === 200) return true;
  if (status === 404) return false;
  return null;
}

/** Record the authoritative outcome into an optional `details` sink (a plain object
 *  the caller passes to saveActiveWorkflow). No-op when absent, so behaviour and the
 *  return value are unchanged for every existing caller/test. */
function recordOutcome(details, mode, { sourcePath, targetPath: tPath, copiedFrom, sourceExternal } = {}) {
  if (!details || typeof details !== "object") return;
  details.mode = mode;
  if (sourcePath !== undefined) details.sourcePath = sourcePath;
  if (tPath !== undefined) details.targetPath = tPath;
  if (copiedFrom !== undefined) details.copiedFrom = copiedFrom;
  // `sourceExternal` marks a source path OUTSIDE the managed workflows dir (an
  // absolute path, #285). The /userdata HEAD oracle cannot address such a path, so a
  // caller must NOT read its 404 as data loss — the external copy path never touches
  // the source file, so the external original is intact but simply unverifiable here.
  if (sourceExternal !== undefined) details.sourceExternal = sourceExternal;
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
 *  per-turn save ONLY on POSITIVE disk proof that the source is never-persisted —
 *  mirroring classifySource's tri-state proof — via an async disk oracle
 *  `existsOnDisk(rawPath) => true | false | null`:
 *    - isPersisted === true              → false (genuinely saved; never auto-ground)
 *    - no usable disk oracle             → false (cannot prove ⇒ refuse)
 *    - no backing path to probe          → false (cannot prove absence ⇒ refuse; the
 *                                          user can still Ctrl+S. An automatic save we
 *                                          cannot verify could still collide.)
 *    - oracle proves ABSENT (404)        → true
 *    - oracle proves PRESENT / unknown   → false (fail safe)
 *  Anything short of a proven absence refuses — never a blind auto-save. */
export async function groundingIsSafe(wf, existsOnDisk) {
  if (!wf) return false;
  if (wf.isPersisted === true) return false;
  if (typeof existsOnDisk !== "function") return false; // no oracle ⇒ cannot prove ⇒ refuse
  const raw = wf.path;
  if (!raw) return false; // pathless ⇒ cannot probe ⇒ refuse (do not blanket-approve)
  let exists = null;
  try {
    exists = await existsOnDisk(raw);
  } catch {
    exists = null; // probe failed ⇒ unknown ⇒ refuse
  }
  return exists === false; // ONLY a proven absence (404) authorizes the save
}

// #330 single-flight: SERIALIZE grounding per workflow SERVICE, not per workflow
// instance. The atomic copy-trio activates a FRESH temporary copy (openWorkflow)
// BEFORE its write commits, so the active-workflow identity changes mid-save — a
// concurrent turn keyed by instance would ground that pre-commit copy under a new
// key and double-save. A per-service chain makes each grounding wait for the prior
// one, then RE-EVALUATE the (now possibly persisted) active workflow.
const _groundingChain = new Map(); // svc -> tail Promise<void>

/** One grounding attempt: probe the ACTIVE workflow's on-disk state, then save the
 *  EXACT SAME workflow it probed (`expect: wf` → saveActiveWorkflow refuses if the
 *  active workflow changed during the async probe, so we never authorize on tab A
 *  and write to tab B). Best-effort: any refusal/hiccup ⇒ null (leave ungrounded). */
async function groundOnce(svc, { existsOnDisk, autoWorkflowName, reconcileSavedCopy } = {}) {
  try {
    const wf = svc?.activeWorkflow;
    if (!needsGrounding(wf)) return null;
    if (!(await groundingIsSafe(wf, existsOnDisk))) return null;
    return await saveActiveWorkflow(svc, undefined, {
      autoWorkflowName,
      existsOnDisk,
      reconcileSavedCopy,
      expect: wf,
    });
  } catch {
    return null;
  }
}

/** #330 — atomically ground the ACTIVE workflow on every agent turn, SERIALIZED per
 *  service so concurrent turns can't create duplicate grounded copies. A later turn
 *  waits for the in-flight grounding to finish and then re-evaluates against the
 *  current active workflow (which, after a successful ground, is persisted → a no-op).
 *  Returns the saved name, or null when nothing was (safely) saved. */
export async function groundActiveWorkflow(svc, opts = {}) {
  // Fast path: nothing to ground and no chain running → skip without touching state.
  if (!needsGrounding(svc?.activeWorkflow) && !_groundingChain.get(svc)) return null;
  const prior = _groundingChain.get(svc) ?? Promise.resolve();
  // Chain AFTER the prior grounding (ignoring its outcome), then re-evaluate now.
  const result = prior.then(() => groundOnce(svc, opts));
  const tail = result.then(
    () => {},
    () => {},
  );
  _groundingChain.set(svc, tail);
  try {
    return await result;
  } finally {
    // Only clear if we're still the tail — a newer queued turn may have extended it.
    if (_groundingChain.get(svc) === tail) _groundingChain.delete(svc);
  }
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
 *     for a temporary copies the graph into a real file and then CONSUMES the
 *     never-persisted source tab (its in-memory record only — there is
 *     provably no source file to destroy), so no modified "Unsaved Workflow"
 *     ghost tab outlives the save (issue #566).
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
  { autoWorkflowName, existsOnDisk, readDiskBytes, reconcileSavedCopy, expect, details } = {},
) {
  const wf = svc?.activeWorkflow;
  if (!wf) throw new Error("no active workflow to save");

  // #330 TOCTOU guard: a caller passes `expect` — the exact workflow it snapshotted
  // BEFORE any async work (a grounding disk probe, or the tool layer's pre-save HEAD).
  // If the active workflow changed in between (the user switched tabs during that async
  // gap), we'd authorize on workflow A but write to workflow B — an overwrite of a
  // DIFFERENT, possibly persisted file. REFUSE instead. Re-checked immediately before
  // every write (assertExpect), since the classify/collision probes below also await.
  // `expect` is undefined only when a caller opts out, leaving behaviour unchanged.
  const assertExpect = () => {
    if (expect !== undefined && svc?.activeWorkflow !== expect) {
      throw new Error(
        "active workflow changed during save — refusing to save the wrong workflow (issue #330)",
      );
    }
  };
  assertExpect();

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
      assertExpect(); // #330: still the workflow we probed?
      // An external source is a REAL existing file (absolute path) copied into the
      // user dir — Save-As COPY semantics, never a first-save (#285). Record it as
      // such so the tool result reports the copy (fixes a first_save mislabel).
      recordOutcome(details, "save-as-copy", {
        sourcePath,
        targetPath: finalTargetPath,
        copiedFrom: currentName,
        sourceExternal: true, // absolute external path — not /userdata-verifiable
      });
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
    // Out-param the adapter fills with its PROVEN produced record: the post-trio
    // active tab, ONLY when token-proof shows it IS the copy the trio just wrote
    // (#566 codex P0 — "whatever is active after the await" is NOT succession
    // evidence; a mid-trio switch to a foreign tab must thread/consume NOTHING).
    const producedRecord = {};
    const atomicCopy = resolveSaveAsCopy(svc, { reconcileSavedCopy, producedRecord });
    if (atomicCopy) {
      assertExpect(); // #330: still the workflow we probed?
      // Authoritative outcome: a "never-persisted" source (a temp / new_workflow tab
      // with no backing file) is a FIRST SAVE (panel#363 — no original to preserve);
      // a "persisted" source is a Save-As COPY of a real file that stays put (#579).
      // (cls is only ever "persisted" or "never-persisted" here — the #226 guard above
      // has already thrown for a temporary source that isn't provably never-persisted.)
      recordOutcome(details, cls === "never-persisted" ? "first-save" : "save-as-copy", {
        sourcePath,
        targetPath: finalTargetPath,
        copiedFrom: cls === "never-persisted" ? undefined : currentName,
      });
      // Capture POSITIVE pre-copy DISK evidence of the source, so the post-copy
      // backstop can only fire on a CONFIRMED 200 → 404 (a genuine move). An in-memory
      // getWorkflowByPath()==null is NOT proof of on-disk loss (it can be transiently
      // stale after the copy activates), so the old in-memory backstop could throw
      // "save moved the original" on a file that is still on disk. Gate on disk only.
      const sourceNorm = normalizePath(sourcePath);
      const sourceOnDiskBefore = await probeSourceOnDisk(existsOnDisk, sourceNorm);
      assertExpect(); // #330: the extra pre-copy probe must not open a switch window
      const activeName = await withConflictRollback(svc, wf, effectiveName, finalTargetPath, () =>
        atomicCopy(wf, effectiveName, finalTargetPath),
      );
      // BACKSTOP: fail LOUDLY only if the copy actually REMOVED a source we CONFIRMED
      // (disk 200) was present and is now CONFIRMED absent (disk 404) — classifyOriginalOnDisk
      // "lost". Every indeterminate case (no oracle / unknown pre or post / in-memory-only
      // signal) is a NO-OP, never a false "moved" (#226).
      if (cls === "persisted") {
        const sourceOnDiskAfter = await probeSourceOnDisk(existsOnDisk, sourceNorm);
        if (
          classifyOriginalOnDisk({ preExisted: sourceOnDiskBefore, postExists: sourceOnDiskAfter }) ===
          "lost"
        ) {
          throw new Error(
            `save moved the original workflow "${sourcePath}" instead of copying it — ` +
              `the source no longer exists on disk (issue #226)`,
          );
        }
      }
      // #566 FIRST-SAVE PREDECESSOR CONSUMPTION (cls === "never-persisted"). The atomic
      // trio saves by COPYING: saveAs builds a NEW object at the target, openWorkflow
      // activates it, saveWorkflow persists it. ComfyUI's own temporary Save-As instead
      // RENAMES the temp tab (one tab, rekeyed) — so our move-free copy leaves the
      // never-persisted SOURCE tab open: a modified "Unsaved Workflow (N)" ghost that
      // outlives both the save AND the later close of the saved tab (the exact #566
      // repro: panel_save_workflow + panel_close_workflow left 34 modified unsaved
      // tabs). The save conceptually CONSUMED that tab — its graph now lives in the
      // persisted copy, and the classifier PROVED no on-disk file backs it — so purge
      // its IN-MEMORY record (identity-safe, disk untouched). Runs ONLY after the
      // copy's successful persist + post-write clobber check above: a failed save
      // keeps the user's unsaved tab. A PERSISTED source is never consumed — a Save-As
      // copy deliberately leaves the original tab open.
      //
      // PROOF GATE (codex P0): consumption requires the adapter's own PROOF that the
      // post-trio active tab IS the copy the trio produced (producedRecord.record,
      // token-matched — the same succession-proof class as the #557 r10 carry: the
      // save's own produced record, never post-await active-tab occupancy). A
      // user/reconnect switch to a DISTINCT tab during the awaited persist fails that
      // proof ⇒ consume NOTHING and thread NOTHING (fail safe: the cosmetic ghost
      // stays — never the #349 wrong-canvas seeding of a foreign tab).
      if (cls === "never-persisted") {
        const produced = producedRecord.record ?? null;
        if (produced) {
          // Stamp BEFORE the identity-safe removal so the source is recognizable
          // through the store's reactive proxies (the token reflects through a Vue
          // proxy) — the same mechanism the copy's own cleanup relies on.
          stampCopyToken(wf);
          removeInMemoryWorkflow(svc, wf);
          // r10 thread for the #557 save-swap identity carry: the PROVEN produced
          // record is the ONLY succession proof the carry accepts. With the
          // predecessor gone, the temp tab's identity can now continue onto its
          // saved successor instead of dying with the ghost.
          if (details) details.savedRecord = produced;
        }
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
  //
  // #442 — an in-place save can spuriously 409 ("Error storing user data file
  // '…': 409 Conflict") over the workflow's OWN name. ComfyUI's UserFile.save()
  // writes with `overwrite: this.isPersisted`, and `isPersisted` is a getter
  // derived from `size` (`isTemporary = size === -1`). After a panel_open_workflow
  // open-ack race the loaded workflow's `size` DRIFTS to -1 (#215/#226), so
  // `isPersisted` reads false, the write goes out with overwrite:false, and the
  // server rejects it because the file already exists.
  //
  // DATA-LOSS GUARD (codex P0): existence alone must NOT authorize the forced
  // overwrite. If the file changed on disk under us (another tab/agent/process
  // wrote B while this tab holds A), forcing overwrite:true would silently CLOBBER
  // B — and the very 409 we're removing was, in that sub-case, correctly protecting
  // it. ComfyUI's /userdata has no If-Match/ETag conditional write, so the achievable
  // guarantee is a byte-exact CONTENT-EQUALITY gate: force the overwrite only when the
  // on-disk bytes STILL MATCH what this tab loaded (wf.originalContent). If disk DIFFERS
  // from the baseline, REFUSE with a surfaced conflict rather than overwrite (the caller
  // reloads or saves under a new name). We are in the NON-relocating branch
  // (finalTargetPath === currentPath === wf.path), so this only ever concerns the
  // tab's OWN file.
  //
  // ACCEPTED RESIDUAL (upstream-only, unchanged from ComfyUI's normal saves): the
  // read→write is not atomic, so a write that lands in the sub-ms window BETWEEN our
  // read and saveInPlace's overwrite:true is not caught — but this is EXACTLY the same
  // non-atomic overwrite:true a normal PERSISTED save already performs on every
  // Ctrl+S, so the drift-repair introduces no window ComfyUI doesn't already have.
  // A true guarantee needs a server-side conditional/version token ComfyUI does not
  // expose; the pre-check closes the realistic "already changed before the save" case.
  assertExpect(); // #330: never in-place-overwrite a workflow the user switched to
  // Split PROBE (async) from MUTATION (sync): the disk read below awaits, so the
  // persistence coercion must NOT run inside it. If the active tab switches during
  // the probe, the trailing assertExpect throws — but a coercion applied before that
  // assert would leave the FORMER tab marked persisted, and a later save of it would
  // skip the oracle and send overwrite:true from an aborted authorization (codex P2).
  // So: probe → assertExpect → THEN coerce synchronously, after the tab is re-verified.
  const inPlace = await classifyInPlaceOverwrite(wf, currentPath, readDiskBytes);
  assertExpect(); // the disk read above awaited — re-check the tab didn't switch
  // A same-OBJECT rename during the await keeps object identity (so assertExpect
  // passes) but changes wf.path — the captured currentPath would no longer identify
  // this tab's file. Refuse rather than authorize/write against a stale path.
  if (normalizePath(wf.path) !== currentPath) {
    throw new Error(
      `refusing to save: the active workflow's path changed during the save (now "${wf.path}") — retry.`,
    );
  }
  if (inPlace === "conflict") {
    throw new Error(
      `refusing to save "${effectiveName}": its file "${currentPath}" changed on disk since this tab ` +
        `loaded it, so saving in place would OVERWRITE those external changes. ComfyUI has no ` +
        `conditional (If-Match) write, so this is guarded by a content-equality check. Reload the ` +
        `on-disk version (panel_load_workflow) to pick it up, or save under a NEW name to keep both ` +
        `(issue #442).`,
    );
  }
  if (inPlace === "authorize") markPersistedForOverwrite(wf); // sync (post-assert) ⇒ no leak window
  recordOutcome(details, "in-place", { sourcePath: currentPath, targetPath: finalTargetPath });
  const savedRecord = await saveInPlace(svc, wf);
  // r10 — thread the save API's own produced record (when it returns one) through
  // details, so the identity carry can prove succession from the replacement
  // EVENT. An empty/non-object return simply carries no thread (fail safe).
  if (details && savedRecord && typeof savedRecord === "object") details.savedRecord = savedRecord;
  return desired || currentName || null;
}

/** #442 — CLASSIFY (no mutation) an IN-PLACE save against a DRIFTED `isPersisted`,
 *  content-equality gated to prevent a destructive overwrite (codex P0). Returns:
 *   - `"authorize"` — the workflow reads non-persisted (drifted) AND the on-disk bytes
 *     STILL MATCH the tab's loaded baseline (`wf.originalContent`). Forcing
 *     overwrite:true here re-saves the user's edits over the SAME file they loaded — no
 *     external content is at risk. This is the case defect 3 fixes.
 *   - `"conflict"` — drifted AND the on-disk bytes DIFFER from the baseline (the file
 *     changed under us). Forcing overwrite would clobber the newer content, so the
 *     caller must refuse and surface a conflict instead.
 *   - `"skip"` — nothing to do: already persisted (ComfyUI's own overwrite:true path
 *     runs), no reader / no path / no baseline to compare, or the file is absent
 *     (disk read null ⇒ overwrite:false safely CREATES it). Leaves behaviour unchanged.
 *
 *  PURE async probe: it never mutates `wf`. `readDiskBytes(path) => Uint8Array | null`
 *  is the authoritative on-disk RAW-BYTE oracle (null = absent/unreadable). Raw bytes —
 *  not decoded text — because Response.text() strips a UTF-8 BOM, so a string compare
 *  would treat `A` and `BOM+A` as equal and authorize a clobber of the BOM-bearing change
 *  (codex P0). The caller applies markPersistedForOverwrite ONLY on "authorize", AFTER
 *  re-asserting the tab. */
export async function classifyInPlaceOverwrite(wf, currentPath, readDiskBytes) {
  if (!wf || wf.isPersisted === true) return "skip"; // already overwrite:true — untouched
  if (typeof readDiskBytes !== "function" || !currentPath) return "skip"; // no oracle ⇒ leave as-is
  const baseline = typeof wf.originalContent === "string" ? wf.originalContent : null;
  if (baseline == null) return "skip"; // no baseline to compare ⇒ cannot prove safe ⇒ leave as-is
  let disk = null;
  try {
    disk = await readDiskBytes(currentPath);
  } catch {
    disk = null; // read threw ⇒ unknown ⇒ do not force (server 409s honestly if it exists)
  }
  // Absent (create) / unreadable / not raw bytes ⇒ leave as-is (never a forced overwrite).
  const bytes =
    disk instanceof Uint8Array
      ? disk
      : disk && typeof disk.byteLength === "number"
        ? new Uint8Array(disk)
        : null;
  if (!bytes) return "skip";
  // Content-equality gate on RAW BYTES vs a canonical UTF-8 encoding of the baseline:
  // only when the on-disk bytes are byte-identical to what this tab loaded is the forced
  // overwrite non-destructive. Any external change — a different graph, or merely an added
  // BOM / re-encoding a string compare would miss — ⇒ conflict, never a clobber. FAILS
  // CLOSED (conflict) if it can't be proven byte-identical (diskBytesEqualText, codex P0).
  return diskBytesEqualText(bytes, baseline) ? "authorize" : "conflict";
}

/** #442 — SYNCHRONOUS mutation that clears a drifted `isTemporary` so ComfyUI's
 *  save() uses `overwrite:true`. `isPersisted`/`isTemporary` derive from `size`
 *  (`isTemporary = size === -1`), so the correction sets the REAL backing field
 *  `size` to a non-(-1) value; the subsequent save() replaces it with the server's
 *  authoritative size. Must be called ONLY after the caller re-asserted the expected
 *  tab (it is synchronous, so no tab switch can interleave). Best-effort + getter-safe
 *  — a frozen/derived `size` is left untouched (the assigns cover plain-object doubles). */
export function markPersistedForOverwrite(wf) {
  if (!wf) return;
  try {
    if (wf.size === -1 || wf.size == null) wf.size = 1;
  } catch {
    /* size not settable ⇒ best-effort */
  }
  safeAssign(wf, "isTemporary", false);
  safeAssign(wf, "isPersisted", true);
}

/** Authoritative tri-state DISK probe for the post-save backstop — the ONLY evidence
 *  trusted to declare a source moved. Returns `true` (confirmed present), `false`
 *  (confirmed absent), or `null` (no oracle / probe threw / inconclusive). Deliberately
 *  NOT backed by the in-memory `getWorkflowByPath`: an in-memory absence is not proof of
 *  on-disk loss (it drifts stale after the copy activates), and treating it as proof
 *  produced a false "save moved the original" on a file still on disk (#226). */
async function probeSourceOnDisk(existsOnDisk, normPath) {
  if (typeof existsOnDisk !== "function" || !normPath) return null;
  try {
    const r = await existsOnDisk(normPath);
    return r === true ? true : r === false ? false : null;
  } catch {
    return null; // probe threw ⇒ unknown ⇒ never alarm
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
 *     instead of a false success.
 *
 *  `producedRecord` is an OPTIONAL out-param object the adapter fills with its
 *  PROVEN produced record (`producedRecord.record = <active tab>`) at a success
 *  point — ONLY when token-proof shows the post-trio ACTIVE tab IS the copy this
 *  trio just wrote (#566 codex P0). "Whatever is active after the awaited persist"
 *  is NOT succession evidence (a user/reconnect switch during saveWorkflow lands
 *  on a foreign tab); this is the same proof class the #557 r10 carry demands —
 *  the save's own produced record, never post-await active-tab occupancy. A proof
 *  failure threads NOTHING (fail safe). */
function resolveSaveAsCopy(svc, { reconcileSavedCopy, producedRecord } = {}) {
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
      // #566 codex P0 — success exit: thread the trio's PRODUCED record into the
      // caller's out-param ONLY with PROOF the post-trio active tab IS the copy
      // this trio just wrote (its proxy-safe token reflects through the store's
      // reactive proxies). A user/reconnect switch to a DISTINCT tab during the
      // awaited persist fails the token match ⇒ thread NOTHING (fail safe), so the
      // caller consumes no predecessor and arms no identity carry for a foreign tab.
      const finish = () => {
        try {
          const activeNow = svc.activeWorkflow;
          if (
            activeNow &&
            isSameCopy(copy, activeNow) &&
            producedRecord &&
            typeof producedRecord === "object"
          ) {
            producedRecord.record = activeNow;
          }
        } catch {
          /* active unreadable ⇒ no proof ⇒ no thread (fail safe) */
        }
        return resolvedName();
      };
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
            return finish();
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
      return finish();
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

/** True when `path` is an ABSOLUTE or ROOT-RELATIVE filesystem path — a Windows drive
 *  ("C:\\", "C:/"), a UNC share ("\\\\server"), a POSIX absolute ("/…"), OR a Windows
 *  root-relative path with a single leading separator ("\packs\…" / "/packs/…", which
 *  resolves against the current drive root). Such a path is a workflow loaded from
 *  OUTSIDE the managed workflows dir (panel_load_workflow path:<file>); it can never be
 *  a /userdata store path (those are relative "workflows/…"), so a Save-As of it must
 *  copy into the user workflows dir rather than the unwritable external directory
 *  (#285). A single leading "\" was previously MISSED, so an external file at
 *  "\packs\Foo.json" was mis-classified as a managed never-persisted tab and reported
 *  as a first save (hiding that a real external source was copied). A managed store
 *  path never begins with a separator, so this never touches the everyday save path. */
function isExternalWorkflowPath(path) {
  const raw = String(path || "");
  if (!raw) return false;
  // A leading "\" or "/" (single, double/UNC, or POSIX absolute) is external/root-
  // relative; ANY "<letter>:" drive prefix is external — INCLUDING drive-relative
  // "C:Foo.json" (no following separator), which resolves against the drive's current
  // directory and is still outside the managed /userdata store. A managed store path is
  // always relative "workflows/…" (no drive letter, no leading separator), so this
  // never touches the everyday save path.
  return /^[a-zA-Z]:/.test(raw) || /^[\\/]/.test(raw);
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
export function normalizePath(path) {
  return String(path || "")
    .replaceAll("\\", "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

async function saveInPlace(svc, wf) {
  // Return the save API's own result: when it yields the workflow record it
  // PRODUCED (a re-registered successor object), that is the one unambiguous
  // replacement-event thread the identity carry can use (r10) — path occupancy
  // proves nothing (a close→reopen occupies the same path with a new identity).
  if (typeof svc.saveWorkflow === "function") return await svc.saveWorkflow(wf);
  if (typeof wf.save === "function") return await wf.save();
  throw new Error("workflow save API unavailable on this frontend");
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
