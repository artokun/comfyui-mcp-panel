// Schedule ComfyUI's expensive ChangeTracker serialization after a bridge reply.
//
// Bridge graph edits must still enter the native undo history, but serializing a
// large nested subgraph synchronously in the command handler delays the rid reply
// long enough for the orchestrator's panel timeout to fire (#581). Capture the
// tracker that owned the completed edit, then yield one UI turn before asking it
// to snapshot. Capturing it matters: looking up activeWorkflow in the callback
// could snapshot a tab the user selected after the edit instead.
//
// comfyui-mcp#1723 — the deferral leaves a WINDOW: until the timer fires, the
// tracker's captured state still describes the canvas BEFORE the panel's own
// edit, and the graph-binding fence reads that lag as a shape mismatch — so a
// back-to-back graph command from the same burst (two calls dispatched in one
// turn, both handled before the timer phase) refused the RIGHT canvas, and every
// mutation needed its own re-open first. The pending record below lets the next
// graph command FLUSH the already-committed capture synchronously before its
// fence runs: the capture was going to happen either way, so flushing changes
// only WHEN it lands, never WHETHER.
//
// panel#1563/#1564 — ASKING FOR A CAPTURE IS NOT GETTING ONE. Measured on the
// live rig (ComfyUI 0.33.2, frontend 1.49.6): `ChangeTracker.captureCanvasState`
// opens with
//
//     if (!app.graph || this.changeCount > 0 || this._restoringState ||
//         ChangeTracker.isLoadingGraph) return
//
// — a SILENT early return. No throw, no return value, nothing to await. While one
// of those windows is open the tracker's `activeState` stops following the canvas,
// and it never catches up on its own: upstream's only self-heal (`squashState`) is
// scheduled from INSIDE a capture that succeeded, so a suppressed capture schedules
// nothing, and `isLoadingGraph` suppresses `squashState` as well. Everything
// downstream then reads a snapshot that is behind the canvas — the binding fence
// refuses the right canvas with `root-shape-mismatch`, and a save (which serializes
// `activeState`, not the live graph) writes a file missing whatever the canvas
// gained.
//
// This is exactly why #1563's proposed fix — awaiting a thenable returned by
// `captureCanvasState` — could not work, and #1564 is the measurement that proved
// it: the suppressed call returns `undefined` synchronously, so there is nothing to
// await. The answer is not to wait longer for one call, it is to NOTICE that the
// call was swallowed and to ask again once the window closes. Every suppression
// condition upstream is transient by construction (mid-undo, mid-load,
// mid-transaction), so a bounded retry chain is all a stranded snapshot needs; the
// durable case is caught instead by the save guard (`decideWorkflowSaveVerdict`),
// which refuses to persist a snapshot that provably lost the canvas.

/** Bounded retry schedule, in ms, for a capture upstream silently skipped.
 *  Short and finite: the suppression windows are transient, and a chain that
 *  never gives up would keep a dead workflow's record alive forever. */
const SUPPRESSED_CAPTURE_RETRY_MS = Object.freeze([16, 50, 150, 400, 800]);

let pendingSnapshot = null;

let _warnedMissingOwnership = false;
function warnMissingOwnershipOnce() {
  if (_warnedMissingOwnership) return;
  _warnedMissingOwnership = true;
  try {
    console.warn(
      "[comfyui-mcp] deferChangeTrackerSnapshot called without an ownership predicate — " +
        "the tracker snapshot cannot be proven to still own the canvas, so it will NOT be " +
        "captured (panel#1563). Undo integration and the back-to-back fence flush stay " +
        "disabled until the caller supplies one.",
    );
  } catch { /* a logger that throws must not also eat the refusal */ }
}

/**
 * Did upstream POSITIVELY tell us this capture was a no-op? (panel#1563)
 *
 * Reads the three fields `captureCanvasState`'s own early return reads. It is
 * deliberately POSITIVE-evidence-only — an unrecognised tracker answers `false`,
 * not `true` — because the one caller that acts on it here RETRIES, and retrying
 * forever on a frontend whose fields were renamed would be a busy loop that no
 * measurement asked for.
 *
 * That is the opposite default from the panel's `captureWasSuppressed`, which
 * answers the different question "may I CLAIM the capture landed" for the
 * destructive close path (#882) and must fail closed on an unknown shape. The two
 * are kept in one place — `captureWasSuppressed` delegates the three conditions
 * here — so the rule itself cannot drift between them; only the default for an
 * unreadable tracker differs, and each caller states why.
 */
export function trackerCaptureSuppressed(tracker) {
  try {
    // TRUTHINESS, not `=== true`. Upstream declares both flags `boolean`, but
    // `captureWasSuppressed` (which delegates here) is a fail-closed guard on a
    // DESTRUCTIVE path, and it read them as truthy before this refactor. Tightening
    // to a strict identity check would let a truthy non-boolean — the exact drift a
    // defensive guard exists for — slip past it. Optional chaining still gives the
    // positive-evidence default this function needs: an absent field is `undefined`,
    // which is falsy, so an unreadable tracker answers "not suppressed" here.
    if (tracker?._restoringState) return true; // an undo/redo is restoring
    if (Number(tracker?.changeCount) > 0) return true; // inside a change transaction
    if (tracker?.constructor?.isLoadingGraph) return true; // a graph is loading
    return false;
  } catch {
    return false;
  }
}

/**
 * Run the capture and report what actually happened.
 *
 *   attempted   a capture function existed and was called (the old return value).
 *   landed      the tracker replaced its snapshot object — positive proof it captured.
 *   suppressed  upstream skipped the call silently and the snapshot did not move.
 *
 * `landed:false, suppressed:false` is the ordinary NO-CHANGE case: the canvas
 * already equals the snapshot, so upstream correctly left it alone. Only the
 * suppressed case is a problem, and only that case is retried.
 */
function captureNow(changeTracker) {
  // `checkState` is DEPRECATED upstream — it warns, then delegates to this — so
  // prefer the current name and keep the old one as the fallback for older
  // frontends (mirrors captureCanvasIntoTracker's resolution order).
  const capture = changeTracker?.captureCanvasState ?? changeTracker?.checkState;
  if (typeof capture !== "function") return { attempted: false, landed: false, suppressed: false };
  // Read through a guard: `activeState` is a plain field today, but a version that
  // makes it a throwing accessor must not blow past the deferred timer.
  const readState = () => {
    try {
      return changeTracker.activeState;
    } catch {
      return undefined;
    }
  };
  const before = readState();
  try {
    capture.call(changeTracker);
  } catch {
    // Older frontends and transient workflow teardown keep undo best-effort. A
    // THROW is not the silent-no-op window this module retries: upstream told us
    // it failed, and retrying a throwing tracker just repeats the failure.
    return { attempted: true, landed: false, suppressed: false };
  }
  const landed = readState() !== before;
  return { attempted: true, landed, suppressed: !landed && trackerCaptureSuppressed(changeTracker) };
}

function armCapture(record, delayMs) {
  // Read the scheduler into a local and call it BARE. `record.schedule(...)` is a
  // METHOD call, so `this` would be the record — and the browser's `setTimeout`
  // rejects any receiver that is not the window with "Illegal invocation", which on
  // the live rig surfaced as the NEXT graph command failing rather than as a timer
  // problem (caught by browser_tests/stale-snapshot-save-refused.spec.ts).
  const schedule = record.schedule;
  record.timer = schedule(() => runAttempt(record), delayMs);
}

/**
 * May this record still capture? (panel#1563 r2)
 *
 * A capture serializes the GLOBAL live canvas into THIS tracker's `activeState`, so a
 * chain that outlives its workflow does not merely waste a timer — it stamps whatever
 * canvas is on screen now into the snapshot of the workflow that armed it, and a later
 * save of that workflow writes the wrong graph over its file. The retry window is
 * exactly where that is reachable: the chain's own stop condition, `isLoadingGraph`, is
 * a CLASS STATIC, so an orphaned record reads "suppressed" for the whole of the next
 * workflow's load and then fires the moment that load completes — when the canvas
 * belongs to someone else.
 *
 * The flush path has always refused on this hazard (its doc names it); the retry path
 * had no equivalent, so it gets the same question. `stillOwnsCanvas` is supplied by the
 * caller because ownership lives in the workflow store and this module is deliberately
 * dependency-light.
 *
 * ASKED POSITIVELY, AT THIS LAYER TOO. The call-site predicate was corrected to require
 * a readable active workflow, but this function still granted on "only a POSITIVE
 * `false` stops the chain, and no predicate behaves as before" — the same
 * unknown-as-permission reading, one layer down, in the function the review flagged.
 * Three unknowns reached `true` through it: no predicate supplied, a predicate
 * answering `undefined`/`null`, and any non-boolean answer. Latent today (the one
 * production caller supplies a strict boolean), which is exactly when it is cheap to
 * close: a default-permit API hands the NEXT caller an authorisation nobody decided to
 * give it, which is the reasoning `graphCommandBindingBar` already applies to
 * `staleTagReadBypass`.
 *
 * So the answer must be a POSITIVE `true`. Everything else — including an unanswerable
 * question and an absent one — abandons the chain. Abandoning costs a snapshot that
 * stays behind the canvas, which the next command's flush can still repair and which
 * `saveWouldPersistStaleSnapshot` refuses loudly rather than losing silently;
 * proceeding costs a wrong-graph write nothing downstream can tell from the user's
 * own work.
 */
function recordMayCapture(record) {
  try {
    return record.stillOwnsCanvas?.(record.tracker) === true;
  } catch {
    return false; // an ownership question that throws is not a licence to write.
  }
}

function dropRecord(record) {
  record.cancelTimer();
  if (pendingSnapshot === record) pendingSnapshot = null;
}

function runAttempt(record) {
  // A flush (or a newer defer) may have consumed the record already; the
  // capture is diff-based and idempotent, so firing anyway is harmless — only
  // the pending marker must not be cleared from under a NEWER record.
  //
  // panel#1563 r2 — but "harmless" holds only while this tracker still owns the
  // canvas. Once it does not, the capture is a WRITE of someone else's graph into
  // this tracker's state; the chain ends here rather than asking again.
  if (!recordMayCapture(record)) {
    dropRecord(record);
    return;
  }
  const outcome = captureNow(record.tracker);
  if (!outcome.suppressed || record.attempt >= SUPPRESSED_CAPTURE_RETRY_MS.length) {
    if (pendingSnapshot === record) pendingSnapshot = null;
    return;
  }
  // Upstream swallowed it. Keep the record pending so the next graph command can
  // still flush it, and ask again after the transient window has had time to close.
  armCapture(record, SUPPRESSED_CAPTURE_RETRY_MS[record.attempt]);
  record.attempt += 1;
}

/**
 * Queue a best-effort ChangeTracker snapshot without blocking the current command
 * reply. Returns whether a snapshot was queued. `schedule` is injectable for the
 * no-DOM unit test; production uses the browser timer.
 */
export function deferChangeTrackerSnapshot(
  changeTracker,
  schedule = setTimeout,
  cancel = clearTimeout,
  stillOwnsCanvas = null,
) {
  if (
    typeof changeTracker?.captureCanvasState !== "function" &&
    typeof changeTracker?.checkState !== "function"
  ) {
    return false;
  }
  // panel#1563 r2 — the record being REPLACED keeps its armed timer otherwise, and an
  // orphan chain is the one that captures into a tracker that no longer owns the
  // canvas. Replacing the marker was never enough to stop it.
  pendingSnapshot?.cancelTimer?.();
  if (typeof stillOwnsCanvas !== "function") {
    // Failing closed must never be SILENT. With no ownership question this module
    // cannot establish that the tracker still owns the canvas, so it captures nothing —
    // say so once, rather than let undo integration and the #1723 flush disappear the
    // way #1667's missing store guard did.
    warnMissingOwnershipOnce();
  }
  const record = {
    tracker: changeTracker,
    schedule,
    attempt: 0,
    stillOwnsCanvas: typeof stillOwnsCanvas === "function" ? stillOwnsCanvas : null,
  };
  record.cancelTimer = () => cancel(record.timer);
  pendingSnapshot = record;
  armCapture(record, 0);
  return true;
}

/**
 * #1723 — run the deferred snapshot NOW, before the caller's next observation of
 * the tracker. Refuses unless the pending record belongs to THIS tracker: a
 * capture serializes the live canvas, so flushing a tracker that no longer owns
 * it would stamp one workflow's canvas onto another's state. Returns whether a
 * pending snapshot was consumed. The timer is cancelled so the capture runs
 * exactly once.
 *
 * panel#1563 — if THIS capture is swallowed too, the record stays pending with its
 * retry chain re-armed rather than being dropped. Consuming it would leave the
 * snapshot stranded behind the canvas with nothing left to move it, which is the
 * state the fence then refuses and the save then persists.
 */
export function flushPendingChangeTrackerSnapshot(changeTracker) {
  const record = pendingSnapshot;
  if (!record) return false;
  if (!changeTracker || record.tracker !== changeTracker) {
    // panel#1563 r2 — this flush is called with the ACTIVE tracker, so a pending record
    // for a DIFFERENT one is stranded: the workflow that armed it no longer owns the
    // canvas, and every remaining retry would capture this tab's graph into that
    // workflow's snapshot. Refusing to flush it was always right; leaving its timer
    // armed was not.
    if (changeTracker) dropRecord(record);
    return false;
  }
  pendingSnapshot = null;
  record.cancelTimer();
  const outcome = captureNow(changeTracker);
  if (outcome.suppressed && record.attempt < SUPPRESSED_CAPTURE_RETRY_MS.length) {
    pendingSnapshot = record;
    armCapture(record, SUPPRESSED_CAPTURE_RETRY_MS[record.attempt]);
    record.attempt += 1;
  }
  return outcome.attempted;
}
