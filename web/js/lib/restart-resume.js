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
//     ARM-TIME is the correct set, not an approximation of a per-workflow one — a
//     reboot restarts ComfyUI globally, so every render in flight at that instant
//     is exposed to the same nudge. See the comment at the arm site in
//     comfyui-mcp-panel.js (`cmd === "comfy_reboot"`) before narrowing this.
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
export function encodeRebootMarker({
  at = null,
  runs = [],
  armedRunCount,
  threadId = null,
  sessionId = null,
  attempts = 0,
  totalAttempts,
} = {}) {
  const ids = normalizeRunIds(runs);
  const armed = Number.isFinite(armedRunCount) ? Math.max(0, Math.trunc(armedRunCount)) : ids.length;
  // TWO different facts, deliberately two fields — conflating them let a bridge drop
  // erase the duplicate evidence while refreshing the budget.
  //
  // `t`  — attempts in the CURRENT delivery episode: the retry BUDGET, which an
  //        observed drop legitimately refreshes (a new connection is a new chance).
  // `ts` — attempts EVER made for this reboot: monotonic, and the cross-mount
  //        evidence for "the agent may already have received a nudge". A resume that
  //        reached the orchestrator and lost only its receipt is exactly the case a
  //        later undisclosed retry would duplicate.
  //
  // Either may be UNKNOWN, and unknown is written by OMITTING the field, never by
  // writing 0. A zero would launder "we have no idea" into "verified none" — and
  // since a retained marker is re-encoded on every wait tick, that laundering would
  // happen within seconds of the uncertainty arising.
  const t = Number.isFinite(attempts) ? Math.max(0, Math.trunc(Number(attempts))) : null;
  const ts =
    totalAttempts === undefined
      ? t // not supplied ⇒ mirrors the episode count (the fresh-arm case)
      : Number.isFinite(totalAttempts)
        ? Math.max(0, Math.trunc(Number(totalAttempts)), t ?? 0)
        : null; // explicitly unknown
  const out = {
    v: REBOOT_MARKER_VERSION,
    at: Number.isFinite(at) ? at : null,
    runs: ids,
    n: Math.max(armed, ids.length),
    // WHICH CONVERSATION asked for this restart. The wait set (`runs`) is global
    // because a reboot is global, but the resume is a message into ONE agent
    // session — delivering it to whatever conversation happens to be on screen
    // when the ready ack lands would nudge a workflow that never asked for a
    // restart while stranding the one that did.
    tid: threadId == null ? null : String(threadId),
    sid: sessionId == null ? null : String(sessionId),
  };
  if (t != null) out.t = t;
  if (ts != null) out.ts = ts;
  return JSON.stringify(out);
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
  const empty = {
    at: null,
    runs: [],
    armedRunCount: 0,
    threadId: null,
    sessionId: null,
    // Unknown, not zero: a legacy/corrupt marker carries no attempt history, and
    // claiming "none were made" would suppress the duplicate warning on a guess.
    attempts: null,
    totalAttempts: null,
  };
  if (text[0] !== "{") return empty; // legacy "1"
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
  // VERSION-GATE. A marker whose shape we don't understand — a future version, or
  // a partial write that happens to still be valid JSON — must not be interpreted
  // field by field. Its `runs` would be trusted while its `at` was absent, and an
  // absent arm time is what makes the wait unbounded. Treat an unrecognized
  // version exactly like the legacy marker: a reboot is pending, nothing is known
  // to be in flight, resume immediately.
  if (parsed.v !== REBOOT_MARKER_VERSION) return empty;
  const runs = normalizeRunIds(parsed.runs);
  const armed = Number.isFinite(parsed.n) ? Math.max(0, Math.trunc(parsed.n)) : runs.length;
  return {
    // `null` means UNKNOWN, and stays null — it is never defaulted to a number.
    // Reading an unknown arm time as 0 would be a definite claim that no time has
    // passed, re-made on every tick, so the backstop would never advance.
    at: Number.isFinite(parsed.at) ? parsed.at : null,
    runs,
    armedRunCount: Math.max(armed, runs.length),
    threadId: typeof parsed.tid === "string" && parsed.tid ? parsed.tid : null,
    sessionId: typeof parsed.sid === "string" && parsed.sid ? parsed.sid : null,
    // `null` = UNKNOWN, never 0. An absent or malformed count is not evidence that
    // no attempt was made, and coercing it to a verified zero is exactly what lets
    // an undisclosed duplicate nudge through.
    attempts: Number.isFinite(parsed.t) ? Math.max(0, Math.trunc(parsed.t)) : null,
    totalAttempts: Number.isFinite(parsed.ts)
      ? Math.max(0, Math.trunc(parsed.ts))
      : Number.isFinite(parsed.t)
        ? Math.max(0, Math.trunc(parsed.t)) // older marker: the episode count is all we have
        : null,
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
  // "Has the wait budget run out?" has THREE answers, and `unknown` is one of them.
  // Whichever definite answer you substitute for it, you are wrong in one direction:
  // 0 elapsed never expires (the wait becomes unbounded and silent), infinite
  // elapsed always expires (a legitimate resume is discarded). Picking a default IS
  // the bug — so every consumer takes the tri-state and decides deliberately.
  const budget = rebootWaitBudget(state.waitedMs, state.maxWaitMs);
  // Here, unknown means the wait cannot be bounded at all, so take the visible,
  // DISCLOSED exit rather than hold the session indefinitely.
  if (budget === "unknown" || budget === "spent") return "resume_unconfirmed";
  return "wait_for_run";
  // NB: `waitedMs` is intentionally not normalized before the helper — clamping a
  // negative elapsed here would hide the unusable-clock case from it.
}

/**
 * Should this resume warn the agent that it may ALREADY have received one?
 *
 * The attempt count is persisted so it survives a reload, but persisting it can
 * fail silently (quota, private mode, eviction) — and `ssSet` returning is not
 * evidence that it stuck. An increment that didn't persist reads back as "no
 * attempt yet", so the next try would go out as a first attempt with no warning:
 * the same shape as trusting a send to mean receipt, one layer down. Written is
 * not persisted.
 *
 * So an unrecorded or uncountable attempt WARNS. A warning wrongly present costs
 * one redundant sentence; a warning wrongly absent is an undisclosed duplicate
 * "continue", which is the hazard this whole fix exists to prevent.
 *
 * The caller supplies `attemptRecorded`, and that evidence is MOUNT-LOCAL: a count
 * whose write failed, whose message landed anyway, and whose storage later
 * recovered reads back after a reload as a real — merely stale — zero, and this
 * returns false for it. That residual is accepted and documented in the PR rather
 * than fixed, because closing it means durably recording a failure at the moment
 * storage refuses to record durably, and the only alternative is warning on every
 * post-reload resume.
 *
 * @param {{totalAttempts?:unknown, attemptRecorded?:boolean, sentThisMount?:number}} state
 * @returns {boolean}
 */
export function rebootResumeRepeatWarning(state = {}) {
  // NO parameter defaults here on purpose. A default would substitute a definite
  // value ("0 attempts", "recorded fine") for an absent one — which is the very
  // mistake this helper exists to prevent. Absent means unknown, and unknown warns.
  const { totalAttempts, attemptRecorded, sentThisMount } = state;
  if (attemptRecorded !== true) return true; // not recorded, or not known to be
  if (Number.isFinite(sentThisMount) && Number(sentThisMount) > 0) return true; // storage-independent
  // The MONOTONIC total, never the per-episode budget: a bridge drop refreshes the
  // budget, and reading the budget here would let a drop erase the evidence that an
  // earlier attempt may already be sitting in the agent's queue.
  if (!Number.isFinite(totalAttempts)) return true; // uncountable / absent ⇒ assume
  return Number(totalAttempts) > 0;
}

/**
 * Was this a REAL bridge drop — a live connection that went away?
 *
 * Only a real drop may refresh the restart-resume retry budget, and "not connected"
 * is not the same statement. A freshly mounted client emits an initial
 * `connecting` status before it has ever been connected, so treating every
 * non-connected status as a drop lets a page RELOAD manufacture one: reload after
 * the budget is spent, the budget resets, and repeated reloads mint unlimited
 * nudges — the storm the budget exists to bound, reached through the one event the
 * persisted budget was supposed to survive.
 *
 * A drop is a TRANSITION out of connected, so it requires having been connected.
 *
 * @param {{everConnected?:boolean, connected?:boolean}} state
 * @returns {boolean}
 */
export function isRealBridgeDrop({ everConnected, connected } = {}) {
  return everConnected === true && connected === false;
}

/**
 * The wait budget as an explicit tri-state.
 *
 * @param {unknown} waitedMs  Elapsed since the reboot was armed, or a non-finite
 *   value when the marker carries no usable arm time.
 * @param {unknown} maxWaitMs
 * @returns {"within"|"spent"|"unknown"}
 */
export function rebootWaitBudget(waitedMs, maxWaitMs) {
  if (!Number.isFinite(waitedMs)) return "unknown";
  // NEGATIVE elapsed means the clock moved backwards (NTP correction, a suspended
  // laptop, a user changing the system time) — so the arm time and "now" are not on
  // the same timeline and the difference measures nothing. Clamping it to 0 would
  // launder that into "no time has passed yet", and the backstop would then wait for
  // the wall clock to catch up before it could ever fire: an unbounded, silent hold.
  // An unusable measurement is an unknown one.
  if (Number(waitedMs) < 0) return "unknown";
  const cap = Number.isFinite(maxWaitMs) ? maxWaitMs : REBOOT_RESUME_MAX_WAIT_MS;
  return Number(waitedMs) >= cap ? "spent" : "within";
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
  // Re-encode through markerFields, NOT a hand-written subset. Pruning is a
  // routine, frequently-called operation (every confirmed delivery), so a field
  // dropped here is dropped almost immediately and permanently — and the field
  // most easily forgotten is the delivery target, whose absence silently converts
  // the marker back into "deliver to whoever is on screen".
  return encodeRebootMarker({ ...markerFields(marker), runs });
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

/** The marker's own fields, so a retained marker round-trips without losing any. */
function markerFields(marker) {
  return {
    at: marker.at,
    runs: marker.runs,
    armedRunCount: marker.armedRunCount,
    threadId: marker.threadId,
    sessionId: marker.sessionId,
    attempts: marker.attempts,
    totalAttempts: marker.totalAttempts,
  };
}

/**
 * One evaluation of the restart-resume state machine: decide, and produce the
 * marker value that must be persisted as a result.
 *
 * The `nextRaw` half is the whole safety property. On either WAIT it is the
 * marker, RETAINED — clearing it there is what loses the resume forever. It is
 * null only when the resume is being sent, or deliberately abandoned with a
 * visible notice.
 *
 * @param {{raw?:unknown, isSettled?:(id:string)=>boolean,
 *          isDeliveryUnconfirmed?:(id:string)=>boolean, currentThreadId?:string|null,
 *          nowMs?:number, maxWaitMs?:number}} args
 * @returns {{decision:"none"|"resume"|"wait_for_run"|"resume_unconfirmed"|"wait_for_session"|"expired_wrong_session",
 *            marker:object|null, owed:string[], unconfirmed:string[], nextRaw:string|null}}
 *   `wait_for_session` — the conversation that armed the reboot is not the one on
 *     screen. Hold; the marker survives so switching back delivers it.
 *   `expired_wrong_session` — it never came back within the wait budget. Abandon
 *     the resume with a VISIBLE notice rather than misdeliver it to whoever is on
 *     screen, and rather than hold it silently forever.
 */
export function stepRebootResume({
  raw,
  isSettled,
  isDeliveryUnconfirmed,
  currentThreadId = null,
  currentSessionId = null,
  sessionKnown = false,
  nowMs = Date.now(),
  maxWaitMs = REBOOT_RESUME_MAX_WAIT_MS,
} = {}) {
  const marker = decodeRebootMarker(raw);
  if (!marker) {
    return { decision: "none", marker: null, owed: [], unconfirmed: [], sessionState: "unknown", nextRaw: null };
  }
  // The agent SESSION behind this conversation may have been replaced rather than
  // resumed (a provider rejected the saved id, a reset, a fresh session hydrated
  // with a transcript replay). Such a session never asked for this restart and may
  // have no memory of the work, so "continue what you were doing" can send it
  // re-reading the graph and re-queueing.
  //
  // This is DISCLOSED, never gated on. A session id legitimately CHANGES across a
  // resume — that is what resuming does — so refusing to deliver on a mismatch
  // would strand the ordinary restart, which is the worse failure.
  //
  // THREE states, not two. The orchestrator reports the post-resume session id in
  // its own `session` frame, which is NOT ordered against the "ready" ack that
  // triggers this decision: when ready lands first, the id on hand is still the one
  // we armed with and a two-state check would confidently answer "same" for a
  // session that is about to be replaced. That is the benign-default trap again, so
  // "we have not been told yet" is its own answer and it discloses.
  const sessionState = !sessionKnown
    ? "unknown"
    : marker.sessionId == null || currentSessionId == null
      ? "unknown"
      : String(currentSessionId) === marker.sessionId
        ? "same"
        : "replaced";
  // Elapsed since the reboot was ARMED, read from the persisted marker so a reload
  // cannot reset the backstop. `null` = unknown, and stays unknown.
  // Deliberately NOT clamped to 0 — a negative difference is evidence the clock is
  // not usable here, and rebootWaitBudget must see it to report "unknown".
  const waitedMs = marker.at == null ? null : nowMs - marker.at;
  const budget = rebootWaitBudget(waitedMs, maxWaitMs);
  const retain = () => encodeRebootMarker({ ...markerFields(marker) });

  // DELIVERY TARGET. The wait set above is global on purpose — a reboot restarts
  // ComfyUI globally, so every in-flight render is exposed — but the resume is a
  // message into ONE agent session. If the conversation on screen is not the one
  // that armed the reboot, sending now would nudge a workflow that never asked for
  // a restart (the duplicate-render hazard, aimed at the wrong target) while the
  // conversation that did ask gets nothing. Hold instead; the marker survives, so
  // switching back delivers it. A marker with no recorded thread (legacy/degraded)
  // carries no constraint and delivers to the current session as before.
  if (marker.threadId != null && String(currentThreadId ?? "") !== marker.threadId) {
    // Only a budget we know to be SPENT may abandon the resume. `unknown` must
    // hold: expiring on it deletes a legitimate resume that switching back to the
    // arming conversation would have delivered — silently, which is the worse
    // failure. Holding is not silent here, because the hold prints a notice naming
    // the conversation the resume belongs to, so the user can act on it.
    const decision = budget === "spent" ? "expired_wrong_session" : "wait_for_session";
    return {
      decision,
      marker: { ...markerFields(marker), runs: marker.runs },
      owed: unsettledRebootRuns(marker.runs, isSettled),
      unconfirmed: pickUnconfirmed(marker.runs, isDeliveryUnconfirmed),
      sessionState,
      nextRaw: decision === "wait_for_session" ? retain() : null,
    };
  }

  const owed = unsettledRebootRuns(marker.runs, isSettled);
  const unconfirmed = pickUnconfirmed(marker.runs, isDeliveryUnconfirmed);
  let decision = planRebootResume({
    rebootPending: true,
    unsettledRuns: owed,
    waitedMs,
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
  const next = { ...markerFields(marker), runs: reported };
  if (decision === "wait_for_run") {
    return {
      decision,
      marker: next,
      owed: reported,
      unconfirmed,
      sessionState,
      nextRaw: encodeRebootMarker(next),
    };
  }
  return { decision, marker: next, owed: reported, unconfirmed, sessionState, nextRaw: null };
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
  if (step.decision === "wait_for_run" || step.decision === "wait_for_session") return step.nextRaw;
  if (step.decision === "expired_wrong_session") return null; // abandoned, with a notice
  // `sent` must mean the ORCHESTRATOR TOOK IT (a receipt ack), not that the socket
  // accepted the bytes. A WebSocket send resolves true the instant it is handed to
  // the transport; the socket can close before the frame is ever read, and there is
  // no way for an abandoned channel to testify that it wasn't. Retiring on that
  // would strand the resume permanently, so an unacknowledged send RETAINS.
  if (sent) return null;
  return step.marker ? encodeRebootMarker(step.marker) : null;
}
