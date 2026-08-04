// Restart-resume decision + the PERSISTENT marker that carries it across a
// frontend reload.
//
// #585: after a ComfyUI restart the panel nudges the agent to "continue what you
// were doing before the restart". If a render queued BEFORE the restart is still
// in flight — or has already finished but its completion frame has not yet
// reached the agent — that generic nudge makes the agent reasonably conclude the
// render was aborted and queue it again. The reporter saw exactly that: the
// duplicate landed behind "1 running" render.
//
// Suppressing the nudge is only half the problem, and the other half is worse.
// Three properties of the thing being guarded against decide the shape of this
// module, because a guard that misses any one of them is not a guard:
//
//  1. It SURVIVES A RELOAD. A restart can reload the frontend, which gives the
//     panel a brand-new, EMPTY run ledger while the reboot marker (sessionStorage)
//     lives on. A guard that consults only in-memory state sees "nothing pending"
//     on the new mount and nudges — reproducing the exact bug one reload later.
//     So the ids being waited on are stored IN the marker.
//
//  2. It SPANS WORKFLOWS. A global "is anything pending" count is not a statement
//     about the render this reboot is waiting on: an unrelated workflow's render
//     makes it true. Suppressing on that — and, worse, clearing the reboot marker
//     while doing so — swallows a legitimate resume permanently, with no error.
//     The user then waits forever for a turn that will never start. That silent
//     failure is worse than the duplicate render it was trying to prevent, so
//     every decision here is made about a SPECIFIC, fixed set of prompt ids: the
//     runs still owed a completion frame at the moment the reboot was armed. The
//     marker is retained while waiting and cleared only when the resume is
//     actually sent.
//
//  3. It completes ASYNCHRONOUSLY. "The tracker retired the run" is not "the agent
//     was told" — the run tracker retires a run optimistically, before the caller's
//     async compose+send resolves. The caller therefore passes an `isSettled`
//     predicate that is true only once no frame is still owed (see
//     run-completion.js `isSettled`), never a pre-delivery signal.
//
// Because both failure directions are real harm, the tie-break is explicit: when
// the runs cannot be confirmed settled within a bounded wait we RESUME rather than
// keep waiting, and the resume discloses the uncertainty and tells the agent to
// check the queue before re-queueing. A duplicate render is visible and
// cancellable; a swallowed resume is silent.

/** Marker schema version — bump only on an incompatible shape change. */
export const REBOOT_MARKER_VERSION = 1;

/**
 * Absolute backstop on suppression. A render legitimately in flight is normally
 * resolved long before this by its own completion / the `/history` reconcile, so
 * this only fires when the outcome genuinely cannot be determined — and then it
 * resumes with a disclosure rather than stranding the user in silence.
 */
export const REBOOT_RESUME_MAX_WAIT_MS = 15 * 60 * 1000;

/** Normalize a run-id list to unique, non-empty strings (ids are strings everywhere). */
function normalizeRunIds(runs) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(runs) ? runs : []) {
    if (raw == null) continue;
    const id = String(raw);
    if (!id || id === "null" || id === "undefined") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Serialize the reboot marker for sessionStorage.
 *
 * @param {{at?:number|null, runs?:Array<string|number>, armedRunCount?:number}} state
 *   `runs` — the ids still owed a completion frame (pruned as they settle).
 *   `armedRunCount` — how many runs were in flight when the reboot was ARMED; kept
 *   after `runs` drains so the resume can say truthfully whether it waited for one.
 * @returns {string}
 */
export function encodeRebootMarker({ at = null, runs = [], armedRunCount } = {}) {
  const ids = normalizeRunIds(runs);
  const armed = Number.isFinite(armedRunCount) ? Math.max(0, Math.trunc(armedRunCount)) : ids.length;
  return JSON.stringify({
    v: REBOOT_MARKER_VERSION,
    at: Number.isFinite(at) ? at : null,
    runs: ids,
    n: Math.max(armed, ids.length),
  });
}

/**
 * Parse a reboot marker. Returns null only when NO marker is present.
 *
 * A legacy `"1"` marker (armed by a build that recorded no ids) and a corrupt
 * marker both decode to a marker with an EMPTY run list — i.e. "a reboot is
 * pending, but nothing is known to be in flight". That deliberately degrades to
 * the pre-#585 behavior (resume immediately) rather than to an indefinite wait:
 * an unknown marker must never be able to strand the session silently.
 *
 * @param {unknown} raw
 * @returns {{at:number|null, runs:string[], armedRunCount:number}|null}
 */
export function decodeRebootMarker(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  const empty = { at: null, runs: [], armedRunCount: 0 };
  if (text[0] !== "{") return empty; // legacy "1"
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
  const runs = normalizeRunIds(parsed.runs);
  const armed = Number.isFinite(parsed.n) ? Math.max(0, Math.trunc(parsed.n)) : runs.length;
  return {
    at: Number.isFinite(parsed.at) ? parsed.at : null,
    runs,
    armedRunCount: Math.max(armed, runs.length),
  };
}

/**
 * Which of `runs` are still owed a completion frame.
 *
 * `isSettled` must answer "no completion frame for this prompt is still owed to
 * the agent" — NOT "the tracker retired it" (that fires before delivery). A
 * missing or throwing predicate means we cannot determine the state, and an
 * undetermined run is reported as UNSETTLED so the bounded-wait path (which
 * discloses) owns the outcome instead of an unguarded nudge.
 *
 * @param {string[]} runs
 * @param {(id:string)=>boolean} [isSettled]
 * @returns {string[]}
 */
export function unsettledRebootRuns(runs, isSettled) {
  const ids = normalizeRunIds(runs);
  if (!ids.length) return [];
  if (typeof isSettled !== "function") return ids;
  return ids.filter((id) => {
    try {
      return !isSettled(id);
    } catch {
      return true;
    }
  });
}

/**
 * Decide what the post-restart "ready" ack should do.
 *
 * @param {{rebootPending?:boolean, unsettledRuns?:string[], waitedMs?:number, maxWaitMs?:number}} state
 * @returns {"none"|"resume"|"wait_for_run"|"resume_unconfirmed"}
 *   `none` — no reboot marker; this ack is not ours.
 *   `resume` — nothing is owed; send the resume nudge and clear the marker.
 *   `wait_for_run` — a SPECIFIC pre-restart run is still owed a completion frame;
 *     stay quiet and KEEP the marker so the resume is reissued when it settles.
 *   `resume_unconfirmed` — the wait budget is spent without a verdict; resume, but
 *     disclose that a render may still be running so the agent checks first.
 */
export function planRebootResume(state = {}) {
  if (!state.rebootPending) return "none";
  const unsettled = normalizeRunIds(state.unsettledRuns);
  if (!unsettled.length) return "resume";
  const maxWaitMs = Number.isFinite(state.maxWaitMs) ? state.maxWaitMs : REBOOT_RESUME_MAX_WAIT_MS;
  const waitedMs = Number.isFinite(state.waitedMs) ? Math.max(0, state.waitedMs) : 0;
  if (waitedMs >= maxWaitMs) return "resume_unconfirmed";
  return "wait_for_run";
}

/**
 * Rewrite a stored marker with the settled runs removed, leaving everything else
 * intact. Keeping the persisted list accurate is what stops a later reload from
 * re-adopting an already-delivered run and having `/history` deliver its
 * completion a second time. Returns `raw` unchanged when nothing moved.
 *
 * @param {unknown} raw
 * @param {(id:string)=>boolean} [isSettled]
 * @returns {string|null}
 */
export function pruneRebootMarkerRaw(raw, isSettled, isDeliveryUnconfirmed) {
  const marker = decodeRebootMarker(raw);
  if (!marker) return typeof raw === "string" ? raw : null;
  if (!marker.runs.length) return typeof raw === "string" ? raw : null;
  const owed = unsettledRebootRuns(marker.runs, isSettled);
  // A run whose delivery was never CONFIRMED is settled (it must not block) but is
  // deliberately NOT pruned away: dropping it here would erase the only evidence
  // that the resume has to disclose rather than assert "your result was delivered".
  const keep = new Set([...owed, ...pickUnconfirmed(marker.runs, isDeliveryUnconfirmed)]);
  const runs = marker.runs.filter((id) => keep.has(id));
  if (runs.length === marker.runs.length) return typeof raw === "string" ? raw : null;
  return encodeRebootMarker({ at: marker.at, runs, armedRunCount: marker.armedRunCount });
}

/** Ids the caller flags as dispatched-but-never-confirmed. */
function pickUnconfirmed(runs, isDeliveryUnconfirmed) {
  if (typeof isDeliveryUnconfirmed !== "function") return [];
  return normalizeRunIds(runs).filter((id) => {
    try {
      return !!isDeliveryUnconfirmed(id);
    } catch {
      return false;
    }
  });
}

/**
 * Re-adopt persisted run ids into a run-completion tracker.
 *
 * A ComfyUI restart can reload the frontend, which gives the panel a brand-new,
 * EMPTY completion ledger. The tracker answers "settled" for any id it has never
 * heard of — correctly, since it owes no frame for it — so a marker read on the
 * new mount would decide "nothing is in flight" for a render that is still
 * executing, and nudge the agent into re-queueing it. Adoption is what closes
 * that: re-pending the ids hands the question to the `/history` + `/queue`
 * reconcile, which is the only thing that actually knows. Ids this tracker
 * already knows (pending, mid-delivery, or terminal) are skipped so a run it has
 * already resolved is never resurrected.
 *
 * @param {string[]} runs
 * @param {{isKnown?:(id:string)=>boolean, onQueued?:(id:string)=>void}} tracker
 * @returns {string[]} the ids newly adopted (empty ⇒ nothing to reconcile)
 */
export function adoptRebootRuns(runs, tracker) {
  const adopted = [];
  const ids = normalizeRunIds(runs);
  if (!ids.length || !tracker || typeof tracker.onQueued !== "function") return adopted;
  for (const id of ids) {
    try {
      if (typeof tracker.isKnown === "function" && tracker.isKnown(id)) continue;
      tracker.onQueued(id);
      adopted.push(id);
    } catch {
      /* a malformed id must never wedge the resume flow */
    }
  }
  return adopted;
}

/**
 * One evaluation of the restart-resume state machine: decide, and produce the
 * marker value that must be persisted as a result.
 *
 * The `nextRaw` half is the whole safety property. On `wait_for_run` it is the
 * marker, RETAINED (pruned to the runs still owed) — clearing it there is what
 * loses the resume forever. It is null only when a resume is actually being sent.
 *
 * @param {{raw?:unknown, isSettled?:(id:string)=>boolean, nowMs?:number, maxWaitMs?:number}} args
 * @returns {{decision:"none"|"resume"|"wait_for_run"|"resume_unconfirmed",
 *            marker:{at:number|null, runs:string[], armedRunCount:number}|null,
 *            owed:string[], nextRaw:string|null}}
 */
export function stepRebootResume({
  raw,
  isSettled,
  isDeliveryUnconfirmed,
  nowMs = Date.now(),
  maxWaitMs = REBOOT_RESUME_MAX_WAIT_MS,
} = {}) {
  const marker = decodeRebootMarker(raw);
  if (!marker) return { decision: "none", marker: null, owed: [], nextRaw: null };
  const owed = unsettledRebootRuns(marker.runs, isSettled);
  const unconfirmed = pickUnconfirmed(marker.runs, isDeliveryUnconfirmed);
  let decision = planRebootResume({
    rebootPending: true,
    unsettledRuns: owed,
    // Elapsed since the reboot was ARMED, read from the persisted marker, so a
    // reload cannot reset the backstop and park the session indefinitely.
    waitedMs: marker.at == null ? 0 : Math.max(0, nowMs - marker.at),
    maxWaitMs,
  });
  if (unconfirmed.length && decision === "resume") {
    // Nothing is BLOCKING any more, but a watched run's completion frame was never
    // confirmed to have reached the agent. Resuming with the plain "your result was
    // already delivered" wording would be a false reassurance that invites exactly
    // the duplicate render this exists to prevent — so downgrade to the disclosing
    // resume, which tells the agent to check the queue first.
    decision = "resume_unconfirmed";
  }
  // Carry BOTH the still-owed and the never-confirmed ids in the persisted marker:
  // pruning an unconfirmed id away while still waiting on a different run would
  // erase the only evidence that the eventual resume must disclose.
  const reported = [...new Set([...owed, ...unconfirmed])];
  const next = { at: marker.at, runs: reported, armedRunCount: marker.armedRunCount };
  if (decision === "wait_for_run") {
    return { decision, marker: next, owed: reported, unconfirmed, nextRaw: encodeRebootMarker(next) };
  }
  return { decision, marker: next, owed: reported, unconfirmed, nextRaw: null };
}

/**
 * The marker value to persist after ATTEMPTING to send the resume.
 *
 * The transport can refuse (a closed socket returns false), and a resume that was
 * never actually sent must not retire its marker — that is the same silent strand
 * as clearing it while suppressing, just reached through a race instead of a
 * branch. So the marker is retired ONLY on a confirmed send; a refused send keeps
 * it so the watch (or the next ready ack) reissues the resume.
 *
 * @param {{decision:string, marker:{at:number|null,runs:string[],armedRunCount:number}|null, nextRaw:string|null}} step
 * @param {boolean} sent
 * @returns {string|null}
 */
export function rebootMarkerAfterSend(step, sent) {
  if (!step || step.decision === "none") return null;
  if (step.decision === "wait_for_run") return step.nextRaw;
  if (sent) return null;
  return step.marker ? encodeRebootMarker(step.marker) : null;
}
