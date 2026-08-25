// Session / reconnect / tab-rebind helpers — pure, side-effect-free logic split
// out of comfyui-mcp-panel.js so it can be unit-tested with `node --test`.
//
// These back the frontend half of the session/tab-binding cluster (panel repo
// issues #278, #334, #296, #291, #207, #332, #310). The orchestrator owns the
// authoritative tab-target + tool registration (comfyui-mcp #512); the panel
// must (a) preserve/rebind the active tab across reboot/soft-reload/free_vram,
// (b) advertise the local COMFYUI_PATH at session init, (c) not report the same
// active tab twice, and (d) degrade gracefully during the reconnect window.

const DEFAULT_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// #278 — Post-reboot autonomous resume. ComfyUI fires `reconnected` after it
// comes back (a Manager reboot, a free_vram bounce, …). We respawn + reconnect
// the orchestrator ONLY when the bridge is actually down AND the session is
// worth resuming. The prior guard resumed only on an explicit REBOOT_KEY /
// AUTOCONNECT_KEY marker, so a reboot that lost the marker stranded a still-live
// workflow conversation ("Connected: none"). A resumable active session is now
// a third, independent reason to reconnect.
export function shouldResumeAfterComfyReconnect({
  bridgeConnected = false,
  rebootPending = false,
  autoConnect = false,
  hasResumableSession = false,
} = {}) {
  // Bridge still up → the orchestrator (and agent) never died; a benign ComfyUI
  // WS blip must NOT bounce a live session.
  if (bridgeConnected) return false;
  return Boolean(rebootPending || autoConnect || hasResumableSession);
}

// #654 — may this ComfyUI `reconnected` re-advertise the tab's bridge route?
//
// The gate above is the RESUME decision and its `if (bridgeConnected) return false`
// is #278's: a benign ComfyUI WS blip must never bounce or respawn a live agent
// session. That guard is not relaxed here — this is a SECOND, cheaper action on
// the branch the resume declines, and the two are mutually exclusive by
// construction (resume needs the bridge DOWN, this needs it UP).
//
// Why that branch needed one at all. The pack is pure-frontend and can no longer
// spawn the orchestrator (`externalOrchestratorMode()` is hardcoded true), so the
// orchestrator ALWAYS survives a ComfyUI restart now and the bridge socket never
// closes. The panel re-registers its bridge route only by sending a `hello`, and
// on this path nothing sends one: `connectAgent()` cannot, because `connect()`
// early-returns on an already-OPEN socket, and no socket `open` handler fires.
// The tab therefore sits on a live socket it never re-announced — the
// orchestrator's post-restart watch waits for a strictly NEWER hello generation
// that will never arrive, so the restart reply's tab-reconnected and
// graph-tools-ready flags both stay false after every successful restart, with a
// manual browser refresh as the only recovery.
//
// This is the same non-destructive repair `shouldRehelloAfterCommand` already
// ships for `free_vram` (#310) — re-advertise the route — but triggered by the
// `reconnected` event rather than a command reply, because at `comfy_reboot`
// reply time ComfyUI is on its way DOWN and a hello then is useless.
//
// A landed hello is NOT a cheap frame, which is what every input below is for.
// It bumps the agent-session epoch (discarding #291's canvas-tool proof), draws
// a fresh `ready` ack (which drives #585's post-restart resume), and runs the
// orchestrator's panel sync. After a real restart all three are exactly what is
// wanted — they are what the socket-drop path does — but firing them on every
// benign blip is the #1138 false-nudge harm. So:
//
//   - `bridgeConnected` false → the socket dropped, and its own `open` handler
//     already sends a hello. A second one here is two greetings and two ready
//     acks for one outage.
//   - `helloLandedSinceOutage` → a hello reached the wire since this outage
//     began (a bridge drop that reconnected FIRST), so the tab is already
//     re-registered. Measured from hellos that provably landed, never from ones
//     the panel meant to send.
//   - `alreadyReadvertised` → one-shot per outage; `reconnected` can repeat.
//   - `outageMs` → the elapsed interval is the ONLY thing separating a real
//     restart from a WS blip (asset view, image check, tab refocus). Same
//     reasoning and same default threshold as `shouldNudgeAfterMidTaskReconnect`
//     below; deliberately one number, not a second one to keep in sync. A
//     persisted `comfy_reboot` marker is delivery state, not proof for this
//     outage, so it cannot bypass this gate unless a current outage-correlated
//     proof is added here.
//
// A duration, not a timestamp to subtract from `now`, for #1145's reason: the
// caller measures the interval once and a duration cannot be silently reread as
// "time since the last drop, whenever that was". Absent, zero, negative or
// unreadable all mean no outage was measured, and no measured outage means no
// re-advertise — the safe direction, since a missed re-advertise leaves the tab
// exactly as wedged as it is today while an invented one re-greets a live agent.
export function shouldReadvertiseAfterComfyRestart({
  bridgeConnected = false,
  outageMs = 0,
  helloLandedSinceOutage = false,
  alreadyReadvertised = false,
  minOutageMs = 6000,
} = {}) {
  if (!bridgeConnected) return false;
  if (helloLandedSinceOutage) return false;
  if (alreadyReadvertised) return false;
  if (typeof outageMs !== "number" || !Number.isFinite(outageMs)) return false;
  if (outageMs <= 0) return false;
  if (typeof minOutageMs !== "number" || !Number.isFinite(minOutageMs)) return false;
  return outageMs >= minOutageMs;
}

/**
 * #1790 — account for a restart re-advertisement only after its hello landed.
 *
 * `sendHello()` is asynchronous: it may wait for the tab-identity lease, be
 * deferred behind in-flight bridge commands, or be superseded by a socket
 * change. A caller that marks the outage handled before that promise resolves
 * can permanently suppress the only hello that would restore graph-tool
 * routing. Keep the in-flight claim separate from the landed watermark, and
 * let the completion callback prove that it still belongs to the reconnect
 * epoch that requested it.
 *
 * This helper deliberately does not retry a failed hello itself. The bridge
 * client owns the socket/route retry paths; this state machine only prevents a
 * failed attempt from becoming false proof, and coalesces duplicate events
 * while one attempt is still resolving.
 */
export function createRestartReadvertiseController() {
  let landedOutageSeq = 0;
  let inFlight = null;

  const validSeq = (value) => Number.isSafeInteger(value) && value > 0;

  return {
    /** True only for a hello that landed, or one already resolving for this outage. */
    isReadvertised(outageSeq) {
      return landedOutageSeq === outageSeq || inFlight?.outageSeq === outageSeq;
    },

    /**
     * Start or join the one hello for an outage. The returned promise always
     * resolves to a boolean and never lets a send failure escape the reconnect
     * lifecycle.
     */
    attempt({ outageSeq, reconnectEpoch, isCurrent, send } = {}) {
      if (!validSeq(outageSeq) || !Number.isSafeInteger(reconnectEpoch) || reconnectEpoch < 0) {
        return Promise.resolve(false);
      }
      if (landedOutageSeq === outageSeq) return Promise.resolve(true);
      if (inFlight?.outageSeq === outageSeq) return inFlight.promise;

      let result;
      try {
        result = typeof send === "function" ? send() : false;
      } catch {
        result = false;
      }
      const promise = Promise.resolve(result).then(
        (sent) => sent === true,
        () => false,
      );
      const record = { outageSeq, reconnectEpoch, promise };
      inFlight = record;
      void promise.then((sent) => {
        if (inFlight === record) inFlight = null;
        let current = true;
        try {
          current = typeof isCurrent !== "function" || isCurrent() === true;
        } catch {
          current = false;
        }
        // A late result from an older reconnect must not mint proof for the
        // current outage. A failed result never advances the watermark.
        if (sent && current) landedOutageSeq = outageSeq;
      });
      return promise;
    },
  };
}

// #654 — the accounting that produces the `outageMs` above, for ComfyUI's OWN
// backend socket (the bridge has its own tracker, `createBridgeOutageTracker`
// below; the two measure different connections and must not be conflated).
//
// It lives here, as a tracker over injected time, for the same reason that one
// does: the defect it guards against is a SEQUENCE, and only a sequence can
// demonstrate it. ComfyUI announces a drop as `reconnecting` AND as a null
// `status` payload, and a frontend can emit several before it comes back — so
// the FIRST one opens the outage and every one after it belongs to the same
// outage. A tracker that re-stamped on each would measure the gap between the
// last two signals instead of the restart, which is #1145 exactly: a 26-second
// restart read as a three-second blip and the recovery withheld.
//
// It also carries the two facts the caller needs to make the decision ONCE per
// outage rather than once per event:
//
//   seq()          — identity of the current outage, advanced when one OPENS, so
//                    it is stamped strictly before any `reconnected` reader can
//                    run whatever order the listeners were registered in. 0 means
//                    no outage has ever opened, which lets a caller's "already
//                    handled" watermark start at 0 with no second sentinel.
//   helloBaseline()— the landed-hello count at the moment the outage opened, so
//                    a bridge that dropped and re-helloed DURING the outage is
//                    distinguishable from one that stayed up throughout.
export function createComfyBackendOutageTracker({ now = () => Date.now() } = {}) {
  // NULL while the backend socket is up, never 0: the panel measures on
  // `monotonicNow()` (performance.now), whose origin is page load, so an early
  // enough drop genuinely stamps a near-zero value. A falsy-0 sentinel would read
  // that as "no outage open" and every later signal would re-stamp it — #1138's
  // mistake, a sentinel sharing a value with real data.
  let startedAt = null;
  let lastOutageMs = 0;
  let outageSeq = 0;
  let baseline = 0;
  const readClock = () => {
    const t = now();
    return typeof t === "number" && Number.isFinite(t) ? t : null;
  };
  return {
    /** A backend down signal. `landedHellos` is the caller's count of hellos that
     *  provably reached the wire, captured as this outage's baseline. */
    noteDown(landedHellos = 0) {
      if (startedAt !== null) return; // inside an outage already — not a new one
      const t = readClock();
      // An unreadable clock cannot open an outage. Nothing is stamped, so the
      // reconnect measures no outage and withholds the re-advertise — the safe
      // direction: a missed one leaves the tab exactly as it is today, an
      // invented one re-greets a live agent.
      if (t === null) return;
      startedAt = t;
      outageSeq += 1;
      baseline =
        typeof landedHellos === "number" && Number.isFinite(landedHellos) ? landedHellos : 0;
    },
    /** The backend socket is back. Closes the outage and records its duration. */
    noteUp() {
      if (startedAt === null) {
        // Ended no outage — records nothing rather than inheriting the previous
        // one as if it were this reconnect's.
        lastOutageMs = 0;
        return;
      }
      const t = readClock();
      // An outage whose end could not be timed measured nothing; closing it with
      // a stale duration would credit this reconnect with the last one's.
      lastOutageMs = t === null ? 0 : Math.max(0, t - startedAt);
      startedAt = null;
    },
    /** The outage this reconnect ended, in ms (0 = none).
     *
     *  Reads LIVE while the outage is still open, so the answer does not depend
     *  on whether the listener that closes it happened to run first. Two
     *  listeners on one event, registered at different times: an ordering
     *  assumption there is what #1327 recurred on. Both orders agree here. */
    outageMs() {
      if (startedAt !== null) {
        const t = readClock();
        return t === null ? 0 : Math.max(0, t - startedAt);
      }
      return lastOutageMs;
    },
    seq() {
      return outageSeq;
    },
    helloBaseline() {
      return baseline;
    },
  };
}

// #310 — free_vram can bounce the ComfyUI connection (models unloaded, the WS
// blips), which drops the orchestrator's tab mapping the way a restart does.
// Re-advertise (rehello) this tab after a successful free_vram so the very next
// graph tool still routes to the connected tab instead of "Connected: none".
export function shouldRehelloAfterCommand(cmd, reply) {
  return cmd === "free_vram" && Boolean(reply && reply.ok);
}

// #1138 — may a `ready` ack arriving mid-task nudge the agent to resume?
//
// The nudge injects a user message ("your connection dropped mid-task … continue exactly
// what you were doing") and writes a line into the durable transcript. Both are false, and
// the injection is actively harmful, unless the orchestrator really did die: a turn that
// kept running does not need resuming, and telling a working agent to resume makes it
// restart or duplicate what it is doing.
//
// The panel's existing rule is a gap heuristic — a real ComfyUI restart takes many seconds
// to come back, so a LONG gap since the drop means the restart was real, while a fast
// reconnect (a sidebar remount, a brief WS blip) means it was not. That rule is right.
//
// What it missed is that "no drop at all" is not the same as "a very old drop", and the
// subtraction cannot tell them apart: the panel's drop stamp was 0 until the bridge
// socket closed, and `Date.now() - 0` is ~56 years — the LONGEST possible gap, which the
// heuristic reads as the strongest possible evidence of a real restart. So the guard was
// exactly inverted where it mattered most: the better established it was that nothing had
// dropped, the more confidently it nudged.
//
// That is reachable on a LIVE socket, because `ready` repeats on one — a re-advertise draws
// a fresh handshake, and #310 re-advertises after every successful free_vram by design. So
// freeing VRAM mid-task could tell a user their connection had dropped when nothing had.
//
// #1145 — and the interval must be the OUTAGE, which is why this takes a measured
// duration rather than a timestamp to subtract from `now`.
//
// The caller used to pass the last drop stamp and let this compute `now - stamp`. That
// made the predicate's answer only as good as the stamp's meaning, and the stamp meant
// the wrong thing twice. It was rewritten by every close, and a close is not once per
// outage: the panel assigns its socket before the connection resolves, so each REFUSED
// retry during a restart re-stamped it, and with backoff doubling the successful attempt
// was separated from the previous failed close by one backoff step. A genuine restart
// that returned inside ~7s therefore measured ~4s and lost its nudge — the guard reading
// its own retry cadence instead of the outage.
//
// A duration also removes the second reading a bare timestamp allows. `now - stamp` is
// "time since the last drop, whenever that was", which keeps answering after the outage
// it described has long ended — so a `ready` repeating on a live socket could be told
// about a drop from ten minutes and two reconnects ago. What this needs to know is how
// long THIS connection was gone, and a duration cannot be silently reinterpreted as
// anything else. The caller measures it once, at the handshake that ended the outage,
// and reports 0 when a handshake ended no outage.
//
// `outageMs` is therefore required to be a positive, finite number of milliseconds:
// absent, zero, negative or unreadable all mean no outage was measured, and no outage
// means no nudge.
//
// #1168 deliberately did NOT add a second input here. The wedge it fixes is an outage
// this predicate never got to see, not a case the threshold judges wrongly, so it is
// fixed by opening that outage (see `noteAgentGone` on the tracker below) rather than by
// letting a caller's conclusion outrank the clock. A first draft did the latter and was
// rejected in review: the panel cannot tell "the orchestrator died" from "my own socket
// went stale while it kept working" — both are an open socket that answers nothing — and
// a bypass would have nudged a live agent mid-turn on the second. The elapsed interval
// is what separates them, so it stays the sole gate.
export function shouldNudgeAfterMidTaskReconnect({ outageMs = 0, minOutageMs = 6000 } = {}) {
  if (typeof outageMs !== "number" || !Number.isFinite(outageMs)) return false;
  // Not `> 0` by accident: a measured outage is a real elapsed duration, so a
  // non-positive one is the never-dropped sentinel, an ended-and-consumed outage, or a
  // clock that ran backwards — none of which is evidence that the orchestrator died.
  if (outageMs <= 0) return false;
  if (typeof minOutageMs !== "number" || !Number.isFinite(minOutageMs)) return false;
  return outageMs >= minOutageMs;
}

// #1145 — the accounting that produces the `outageMs` above.
//
// It lives here, as a tracker over injected time, because the defect it fixes is a
// SEQUENCE and only a sequence can demonstrate it: one close is indistinguishable from
// another, and what went wrong was that four of them in a row each reset the clock.
// Nothing about that is visible in a single call, and a source scan over the panel is
// not an option — #1096's review proved by mutation that token-presence scans over that
// file stay green when the logic under them is inverted. A tracker can be driven through
// the real order of events (drop, refused retry, refused retry, handshake) and asked
// what it measured, which is the one question the bug got wrong.
//
// The three events it distinguishes:
//   noteBridgeClosed()  — a socket closed. The FIRST one opens an outage; every one
//     after it belongs to the same outage and must not move its start. The panel assigns
//     its socket at construction, before the connection resolves, so a refused reconnect
//     attempt arrives here exactly like a genuine drop does.
//   noteHandshake()     — a real orchestrator handshake landed, which is where an open
//     outage ENDS and its duration is finally known. A handshake with no outage open is
//     a re-advertise on a live socket (#310 does one after every free_vram) and records
//     nothing rather than inheriting the previous outage as if it were its own.
//   noteAgentGone()     — the panel CONCLUDED the agent behind the bridge socket is gone.
//     Opens an outage exactly as a close does, and is a separate event only because the
//     DECISION differs: a close is observed, this is concluded. See its body.
//   noteTurnStarted()   — a new agent turn began, so outages that ended before it are no
//     longer evidence about the turn now running. This is what stops a real but settled
//     drop from being re-read later as this turn's — the #1138 defect with a stale
//     timestamp in place of the 0 sentinel.
export function createBridgeOutageTracker({ now = () => Date.now() } = {}) {
  // When the current outage began; NULL whenever the bridge is up.
  //
  // Null rather than 0, and tested with `=== null` rather than for truthiness, because
  // 0 is a LEGITIMATE reading here: the panel measures on `monotonicNow()`
  // (performance.now), whose origin is page load, so an early enough close genuinely
  // stamps a near-zero value. A falsy-0 sentinel would read that as "no outage open" —
  // the outage would never close, every later close would re-stamp it, and the backoff
  // step would be back. That is #1138's mistake exactly: a sentinel sharing a value
  // with real data.
  let startedAt = null;
  // The outage the current turn has seen, in ms; 0 means "no drop during this turn".
  let outageMs = 0;
  const readClock = () => {
    const t = now();
    return typeof t === "number" && Number.isFinite(t) ? t : null;
  };
  return {
    noteBridgeClosed() {
      if (startedAt !== null) return; // inside an outage already — not a new one
      const t = readClock();
      // An unreadable clock cannot start an outage. Leaving startedAt null means the
      // handshake records no duration, so the nudge is withheld — the safe direction:
      // a missed nudge leaves an idle agent, an invented one derails a working agent.
      if (t !== null) startedAt = t;
    },
    // #1168 — the panel CONCLUDED the agent behind the bridge socket is gone, so the
    // outage starts HERE.
    //
    // A wedged orchestrator holds its connection OPEN and answers nothing, so the close
    // listener never runs. The outage it caused is therefore not merely mismeasured, it
    // is never opened at all — and when the wedged process finally dies the clock starts
    // from that moment, so a user who restarts it promptly measures the RESTART. Minutes
    // with no agent behind the socket are weighed as a three-second blip and the turn the
    // wedge killed is never resumed.
    //
    // Same body as noteBridgeClosed above, and a separate method for the DECISION, not
    // the effect. That name means "a socket closed" — an observation. This one is a
    // conclusion the panel reaches after a bounded ladder of cold-start windows and
    // redials, and it is a conclusion only its caller can be trusted to have earned.
    // Keeping it separate is what stopped the two rejected attempts from being spelled
    // as this one: they stamped an outage in the shared teardown helper (~17 call sites,
    // most of them a LIVE orchestrator being re-pointed) and in the handshake REDIAL,
    // whose own doc calls it the agent-not-ready-YET case.
    //
    // What it deliberately does NOT do is exempt the death from the threshold. The panel
    // cannot distinguish "the orchestrator died" from "my own socket went stale while it
    // kept working" — a half-open TCP after a sleep, a NAT idle-kill or a VPN flap looks
    // identical from here — so a conclusion is evidence that an outage BEGAN, never that
    // it was long enough to have killed the turn. The elapsed interval is what separates
    // the two, and it stays the sole gate: a live orchestrator that answers again
    // moments later measures short and is left alone, while a wedge the user has to
    // notice and restart by hand cannot be.
    noteAgentGone() {
      if (startedAt !== null) return; // already inside an outage — not a new one
      const t = readClock();
      // An unreadable clock cannot start an outage; see noteBridgeClosed for why that is
      // the safe direction.
      if (t !== null) startedAt = t;
    },
    noteHandshake() {
      if (startedAt === null) return; // ended no outage — records nothing
      const t = readClock();
      // Clamped at 0: a backwards clock adjustment mid-outage must not hand the
      // predicate a negative duration to reason about.
      if (t !== null) outageMs = Math.max(0, t - startedAt);
      // Closed either way — an outage whose end could not be timed is still over, and
      // leaving it open would let the NEXT drop measure from this one's start.
      startedAt = null;
    },
    noteTurnStarted() {
      // #1163 — CLOSE the outage, do not merely zero the total.
      //
      // Zeroing alone left `startedAt` running across the turn boundary, so an outage
      // that began before the turn was still measured from before the turn existed.
      // That is reachable, not theoretical: `sendUserMessage` requires only an OPEN
      // socket, not a completed handshake, and the socket reopens well before the
      // `models` frame — up to 45s earlier on a cold backend. A user who types into
      // that gap gets `turn:working`, then the late handshake measures the pre-turn
      // drop, and the `ready` ack tells the agent its connection dropped mid-task and
      // to resume — on top of the message the user sent seconds ago. The agent
      // restarts or duplicates the work it was just asked to do: the exact
      // false-nudge-into-a-live-session harm #1138 exists to prevent.
      //
      // What this frame actually proves is narrower than "the orchestrator survived",
      // and the narrow claim is the one that matters: A TURN IS IN FLIGHT RIGHT NOW.
      // The nudge exists solely to rescue an agent left IDLE — a session resumed with
      // full context and no pending turn. An agent that is working is not idle, so
      // there is nothing to rescue, whether the turn is the original one re-announced
      // by an orchestrator that survived or a brand-new one the user just typed into a
      // respawned agent. Nudging either is the harm: "continue exactly what you were
      // doing before the drop" makes a working agent restart or duplicate.
      //
      // The converse is what keeps the feature alive: an orchestrator that died has no
      // turn to announce, so nothing arrives before the `ready` ack, the outage stands
      // and the nudge fires. Both directions are pinned by tests, so this can never be
      // satisfied by simply never nudging.
      startedAt = null;
      outageMs = 0;
    },
    /** The outage the current turn has seen, in ms (0 = none).
     *
     *  While the bridge is still marked DOWN this measures LIVE from the outage start
     *  instead of reporting the last closed one. That is not a nicety — the reader is
     *  the `ready` ack, and `ready` does not wait for the handshake that closes an
     *  outage. The orchestrator pushes its models frame from an async continuation
     *  (`void ensureModels(backend).then(…)`) while the ready ack goes out
     *  synchronously once hello is processed, so for any backend whose model discovery
     *  costs a probe, `ready` arrives FIRST. Reporting the closed value there would
     *  answer 0 for an outage still in progress and swallow the nudge on exactly the
     *  real restart this exists to catch — a fresh way to lose it, in the change that
     *  fixed the old one. Measuring live is also what the pre-#1145 code did: a stamp
     *  can be subtracted from at any moment, and that property has to survive.
     *
     *  This does NOT reintroduce the backoff-step defect: `startedAt` is still written
     *  once, by the first close, so a live reading measures from the outage's start and
     *  not from the most recent refused retry. */
    outageMs() {
      if (startedAt === null) return outageMs;
      const t = readClock();
      // Clamped for the same reason noteHandshake clamps: a clock that ran backwards
      // reports no outage rather than a negative one.
      return t === null ? outageMs : Math.max(0, t - startedAt);
    },
    /** True while the bridge is down — the outage has begun but not yet ended, whether
     *  a close observed that or #1168's noteAgentGone concluded it.
     *  Read by the tests that pin the open/closed transitions; the panel decides on
     *  outageMs() alone, so this stays a state ACCESSOR and never a second predicate. */
    isDown: () => startedAt !== null,
  };
}

// #332 — During the post-restart reconnect window a Manager-backed fetch (e.g.
// panel_list_nodes) throws a bare transport error ("Failed to fetch") before any
// HTTP status exists, so the usual 404/"unreachable" handling never fires. Match
// those transient transport failures so they can be retried / reworded instead
// of surfaced raw.
export function isTransientReconnectError(err) {
  const msg = String((err && err.message) || err || "");
  return /failed to fetch|networkerror|network error|load failed|fetch failed|connection (was )?lost|err_connection|econnrefused|econnreset|socket hang up/i.test(
    msg,
  );
}

// Bounded retry for a call that may hit the reconnect window. Retries ONLY
// transient transport failures (isTransient), with capped exponential backoff.
// A non-transient error propagates immediately (unchanged behavior); a transient
// failure that never clears is reworded into an actionable "still reconnecting"
// message rather than a raw "Failed to fetch".
export async function retryDuringReconnect(
  fn,
  {
    attempts = 4,
    baseDelayMs = 250,
    maxDelayMs = 2000,
    sleep = DEFAULT_SLEEP,
    isTransient = isTransientReconnectError,
    label = "ComfyUI/Manager",
  } = {},
) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const last = i === attempts - 1;
      if (!isTransient(err) || last) break;
      await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** i));
    }
  }
  if (isTransient(lastErr)) {
    const detail = String((lastErr && lastErr.message) || lastErr || "");
    // Preserve the original error as `cause` so its type/stack are not lost —
    // and word it as "not reachable right now (may still be reconnecting)"
    // rather than asserting a restart, since a persistent CORS/proxy/Manager
    // outage can look the same at the transport layer.
    throw new Error(
      `${label} is not reachable right now (it may still be reconnecting after a restart) — retry in a moment.` +
        (detail ? ` (${detail})` : ""),
      { cause: lastErr },
    );
  }
  throw lastErr;
}

// #379 — softReload() drops the bridge (client.stop) BEFORE the /reload POST so
// the old orchestrator can free the port, then OWNS the respawn (client.start →
// onAck resumes the conversation). But this published pack's /reload route is a
// by-design 503 (the orchestrator runs out-of-band and never stops), so the POST
// is ALWAYS refused — and the old code `return`ed on that path with the bridge
// still stopped, wedging the panel "connected chip / dead bridge" with no
// auto-recovery, every time. This decides the recovery from the POST outcome:
//   - reconnect is ALWAYS true — the dropped bridge must be restored on every
//     path (accepted → the fresh orchestrator binds; refused/unreachable → the
//     orchestrator never stopped, so reconnecting restores the live bridge).
//   - keepResumeInterlock (SOFT_RELOAD_KEY + soft-reload guard) is kept ONLY for
//     an accepted respawn we own; a refused reload has no respawn to interlock,
//     so it is cleared and the normal reconnect + hello.resume restores the
//     session against the still-running orchestrator.
export function planSoftReloadRecovery({ ok = false, reachable = true } = {}) {
  const accepted = Boolean(reachable && ok);
  return { accepted, reconnect: true, keepResumeInterlock: accepted };
}

// #379 / #419 — the soft-reload LIFECYCLE, extracted from softReload() so the
// "a reload never leaves a bridge dead" guarantee is unit-testable at the
// stop→start level (the pure planSoftReloadRecovery decision alone can't lock it,
// because reconnect is unconditional and not branched on). #419 reported a reload
// leaving open sidebar tabs permanently disconnected; the guarantee that fixes it
// is exactly this: EVERY tab that runs a reload drops its bridge and is ALWAYS
// restored, whatever the POST outcome (accepted respawn we own, a by-design 503
// refusal, an unreachable/timed-out POST, or a throw from the effect callbacks).
//
// Pure control-flow over injected effects (so a test drives it with spies, and so
// each open tab runs the SAME sequence independently on its own bridge — there is
// no shared state one tab could leave dead for the others):
//   1. client.stop()      — drop the bridge so the old orchestrator frees the port
//   2. postReload()       — the bounded reload POST → { ok, reachable } | throws
//   3. planSoftReloadRecovery(outcome) — keep the resume interlock ONLY for an
//      accepted respawn we own; otherwise clear it + surface a reconnect note
//   4. client.start()     — ALWAYS, in a finally, even if a callback throws, so the
//      bridge can never be stranded stopped (the #419 no-dead-bridge invariant)
export async function performSoftReloadRecovery({
  client,
  postReload,
  onKeepInterlock,
  onClearInterlock,
  note,
  // Runs immediately BEFORE client.start(), inside the same finally — the caller
  // uses it to clear its `reloading` re-entrancy flag right before the reconnect,
  // preserving the pre-extraction ordering (flag cleared, THEN start). Best-effort:
  // a throw here never blocks the start below.
  beforeStart,
  plan = planSoftReloadRecovery,
} = {}) {
  // Drop the bridge; a throw here must NOT skip the client.start() below.
  try {
    client.stop();
  } catch {
    /* stop is best-effort — start() still runs so the bridge is never stranded */
  }
  let outcome;
  try {
    const res = await postReload();
    // A response (any HTTP status, incl. the by-design 503) means the route was
    // REACHABLE; only a throw/timeout is unreachable.
    outcome = {
      ok: Boolean(res && res.ok),
      reachable: !res || res.reachable !== false,
      startCommand: (res && res.startCommand) || "",
    };
  } catch (error) {
    outcome = { ok: false, reachable: false, startCommand: "", error };
  }
  let decision;
  try {
    // The recovery DECISION and its best-effort UI/state effects are all inside
    // this try so that NOTHING between the stop above and the start below — not a
    // throwing injected `plan`, not a throwing interlock/note callback — can strand
    // the bridge or surface as a "reload failed". The finally guarantees reconnect.
    decision = plan({ ok: outcome.ok, reachable: outcome.reachable });
    if (decision.keepResumeInterlock) {
      // Accepted respawn we own — keep SOFT_RELOAD_KEY + guard so the fresh
      // orchestrator binds and onAck resumes; nothing else to do here.
      onKeepInterlock?.(outcome);
    } else {
      // Refused/unreachable — stand the interlock down and reconnect the dropped
      // bridge against the still-running orchestrator (no wedge).
      onClearInterlock?.(outcome);
      note?.(outcome);
    }
  } catch {
    /* decision/effects are best-effort — never block the reconnect below */
  } finally {
    // The invariant: reconnect on EVERY path, even if the decision/effects threw.
    // beforeStart runs first (the caller clears its `reloading` flag here, matching
    // the pre-extraction "flag cleared THEN start" ordering); both are isolated so
    // neither can strand the bridge.
    try {
      beforeStart?.();
    } catch {
      /* best-effort pre-start hook — never block the reconnect */
    }
    try {
      client.start();
    } catch {
      /* start scheduling is best-effort; a throw here must not mask the outcome */
    }
  }
  // reconnect is always true by contract; keep it present even if `plan` threw.
  return { reconnect: true, ...(decision || {}), outcome };
}

// #207 / #334 — Stable identity for a workflow tab record. A load that replaces
// the active canvas can flip the tab id (tmp: → wf:) or re-add the same file, so
// dedupe on the rename-stable identity. Strip the tmp:/wf: scheme prefix so the
// path form ("workflows/a.json") and the key form ("wf:workflows/a.json") of the
// SAME file converge, normalize separators, and drop the .json suffix. Case is
// PRESERVED so distinct files on a case-sensitive (Linux) filesystem are never
// collapsed; the frontend reports a stable casing per file so real duplicates
// still match.
export function workflowTabKey(rec) {
  if (!rec || typeof rec !== "object") return "";
  // ONLY a path or a path-bearing key is a stable identity. A bare `filename` is
  // NOT: multiple unsaved tabs share the name "Unsaved Workflow", and a filename
  // "foo" would otherwise collide with the saved file "foo.json". Records with no
  // real path/key return "" and are kept as DISTINCT (never deduped).
  let s = String(rec.path || rec.key || "").replace(/\\/g, "/");
  const scheme = s.match(/^(tmp|wf):(.*)$/);
  if (scheme) {
    // `wf:` always denotes a real SAVED path (even a root-level "wf:foo.json"),
    // so strip it unconditionally to unify with the path form "foo.json". `tmp:`
    // is an ephemeral tab id that may be a bare token ("tmp:<uuid>") — strip it
    // ONLY when a real path follows (contains "/") so a pathless temp tab keeps
    // its own namespace and can never collide with a saved file of the same name.
    if (scheme[1] === "wf" || scheme[2].includes("/")) s = scheme[2];
  }
  // Case-sensitive .json strip (workflows are always lowercase ".json") and
  // case-PRESERVING otherwise, so case-distinct files on a case-sensitive
  // (Linux) filesystem are never collapsed.
  return s.replace(/\.json$/, "").trim();
}

// #207 — panel_load_workflow could leave panel_list_workflows reporting the SAME
// active tab several times (each load appended a record instead of updating one),
// and a later save then 409'd. Collapse records that share a stable key into one,
// preferring the active/persisted flags and the freshest fields. Unkeyed records
// (a blank/Unsaved tab with no path) are kept as-is — they are genuinely distinct.
export function dedupeWorkflowTabRecords(records) {
  if (!Array.isArray(records)) return [];
  const byKey = new Map();
  const out = [];
  for (const rec of records) {
    if (!rec) continue;
    const key = workflowTabKey(rec);
    if (!key) {
      out.push(rec);
      continue;
    }
    const prev = byKey.get(key);
    if (!prev) {
      const slot = { index: out.length };
      byKey.set(key, slot);
      out.push(rec);
      slot.ref = rec;
    } else {
      out[prev.index] = mergeTabRecord(out[prev.index], rec);
    }
  }
  return out;
}

function mergeTabRecord(prev, next) {
  return {
    ...prev,
    ...next,
    active: Boolean(prev.active || next.active),
    persisted: Boolean(prev.persisted || next.persisted),
    modified: Boolean(prev.modified || next.modified),
  };
}

// #207 / #334 — Args for app.loadGraphData when panel_load_workflow replaces the
// active canvas. Passing the active workflow as the 4th arg ASSOCIATES the load
// with the existing tab (exactly like workflow_open does), so the graph replaces
// the persisted tab IN PLACE instead of spawning a new "Unsaved Workflow" tab
// (the dup-tab-record + frozen-routing report). With no active workflow (a truly
// blank canvas) we fall back to the plain single-arg load.
export function resolveLoadGraphArgs(graphData, activeWorkflow) {
  if (activeWorkflow && typeof activeWorkflow === "object") {
    return [graphData, true, true, activeWorkflow];
  }
  return [graphData];
}

// #296 / #291 — Session-init hello frame. Centralizing it guarantees every
// session advertises the same fields, and adds `comfyui_path`: for a LOCAL
// portable ComfyUI the orchestrator otherwise has no workspace path, so it
// reports "no COMFYUI_PATH configured" and skips registering the live panel_*
// graph tools. Propagating the embedded ComfyUI's base path at init lets the
// orchestrator register those tools independent of any CLI workspace config.
export function buildHelloPayload({
  tabId,
  title,
  panelVersion,
  vocabularyHash,
  backend,
  blind = false,
  comfyuiUrl,
  comfyuiPath,
  tabSessionId,
  resume,
  workflowUuid,
  lostReplies,
} = {}) {
  const frame = {
    type: "hello",
    tab_id: tabId,
    title,
    panel_version: panelVersion,
    // #236 — the tool vocabulary THIS build vendored, so the orchestrator can compare
    // it against its own AT CONNECT rather than letting the skew surface one failed
    // tool call at a time as "unknown tool".
    //
    // A version string cannot do this job: two builds of one version can carry
    // different vocabularies, and two versions can carry identical ones. A hash of the
    // vocabulary changes exactly when the thing it identifies changes.
    //
    // Safe in both directions of skew. An orchestrator predating the check ignores an
    // unknown hello field; one that has it treats an ABSENT hash as UNVERIFIED, never
    // as disagreeing — so neither an old panel nor an old server is ever reported as
    // wrong on the strength of a field it does not send.
    //
    // Passed IN rather than imported, like panelVersion: this module stays free of the
    // panel bundle so its unit tests can build a hello without one.
    vocabulary_hash: vocabularyHash,
    backend: backend || "claude",
    blind: Boolean(blind),
    // #570 P0c — advertise that THIS panel build enforces the per-command workflow-instance
    // stamp: it refuses to run ANY active-workflow op whose stamped workflow_uuid does not match
    // the active canvas — every graph_* command AND the four active-workflow mutators
    // (workflow_save / workflow_save_as / workflow_rename / workflow_close). The fence is in the
    // command handler (activeWorkflowFenceApplies), before every executor, so it spans all of
    // them. The orchestrator FAILS CLOSED for those mutations unless a connected panel confirms
    // this, so an OLD panel that would silently ignore the stamp and apply a stale write to the
    // wrong workflow gets read-only graph access until updated.
    // SCOPE: this is ACCIDENTAL version-skew protection for an honest user, NOT a security
    // boundary — the flag is self-asserted, so a modified panel can spoof it, but that only
    // leaks the user's own workflow into their own workflow (self-attack). No attestation.
    enforces_workflow_stamp: true,
    // #718: graph_set_widget awaits fresh backend metadata before its write and
    // must recheck the stamp after that await. This separate capability lets a
    // newer orchestrator fail closed for an older bundle that only fences at
    // initial dispatch.
    enforces_workflow_stamp_at_write: true,
    // #2107: graph_set_widget honors optional expected_node_type at the
    // synchronous write boundary, so the orchestrator can fence a node
    // replacement between its final identity probe and mutation.
    enforces_expected_node_type_at_write: true,
    // Advertise that this build understands `agent_note` — an orchestrator frame that is
    // delivered to the AGENT ONLY and never rendered as a chat bubble.
    //
    // It must be a capability rather than an assumption. An older panel silently ignores
    // an unknown frame type, so an orchestrator that switched unconditionally would make
    // these notices vanish for everyone who has not updated — trading a wall of text for
    // no text at all, which is the worse failure. The orchestrator keeps using `say` when
    // this flag is absent.
    accepts_agent_notes: true,
  };
  // #709 — a browser-tab-scoped identity, deliberately separate from the
  // workflow routing id. `tab_id` is normally a workflow path and can therefore
  // recur in another browser tab. The orchestrator snapshots this before a
  // ComfyUI restart and only certifies readiness when the SAME browser tab
  // reconnects afterwards. It is an honest-local correctness guard, not an
  // attestation; old panels omit it and are conservatively not restart-ready.
  if (typeof tabSessionId === "string" && tabSessionId.trim()) {
    frame.tab_session_id = tabSessionId.trim();
  }
  if (comfyuiUrl) frame.comfyui_url = comfyuiUrl;
  if (typeof comfyuiPath === "string" && comfyuiPath.trim()) {
    frame.comfyui_path = comfyuiPath.trim();
  }
  if (resume) frame.resume = resume;
  // #570 — the durable, globally-unique per-instance workflow uuid (survives the
  // tmp:<uuid> tab-id churn across a reload, unlike the tab id and the default
  // title). Lets the orchestrator key an UNSAVED workflow's resume on a stable
  // identity that never collides with a DIFFERENT unsaved workflow of the same
  // title (the reopened cross-resume). Omitted when unknown so old behavior stands.
  if (typeof workflowUuid === "string" && workflowUuid.trim()) {
    frame.workflow_uuid = workflowUuid.trim();
  }
  // #508 — command outcomes this tab COMPLETED but could not deliver (the socket closed
  // or was superseded mid-command). Advertising them lets the other end reconcile "the
  // reply was lost" against its own timed-out commands instead of asserting the
  // unestablished "the tab may be backgrounded or frozen". Omitted when empty so the
  // common hello is unchanged.
  // #694 — the panel no longer passes this on the hello: the hello fires at socket-open,
  // BEFORE the models handshake stamps the socket's session epoch, so a hello-carried
  // summary is filtered with an unknown epoch and can contradict the epoch-filtered
  // replay. The summaries ride the post-handshake `lost_replies` frame (sent from
  // replayLostReplies with the SAME epoch filter the replay uses). The field remains
  // supported here for any caller whose timing is already post-handshake.
  if (Array.isArray(lostReplies) && lostReplies.length) {
    frame.lost_replies = lostReplies;
  }
  return frame;
}
