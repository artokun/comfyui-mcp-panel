// #508 / #402 — the panel half of "did the agent's command reach a live handler?".
//
// Field report (#508): the sidebar chat stayed CONNECTED and accepted the user's
// request, yet EVERY frontend command timed out with no reply from the registered tab —
// `set_todo` (5000 ms), `graph_outline` (6000 ms), `workflow_list` (6000 ms) — while the
// orchestrator kept targeting the same `wf:…` id. A row of identical timeouts, forever.
//
// The panel's command handler had two ways to swallow a command silently:
//
//   a. A HOST CALLBACK THROWING BEFORE THE REPLY. `onCommandReceived()` (the turn-activity
//      marker) ran OUTSIDE the try/catch that produces the reply, and the listener is
//      async, so a throw there became an unobserved rejection: no reply, no error, no
//      log — for every command, deterministically, while chat kept working (chat frames
//      never touch that callback). That is exactly the reported shape, `set_todo`
//      included — `set_todo` has no executor to hang, so only a pre-reply throw explains
//      it timing out.
//
//   b. A SUPERSEDED-SOCKET EARLY RETURN. The #379 instance guard drops a stale socket's
//      whole continuation, INCLUDING its reply, even though replying on that same socket
//      is what the command's sender is waiting for. (This guard postdates the reporter's
//      0.11.20, so it is not their cause — but it is a standing one.)
//
// The structural fix in the panel is: a command frame ALWAYS produces a reply attempt on
// the socket it arrived on, and every host callback around it is isolated so UI code can
// never suppress a bridge reply. What remains is honesty about the cases where the reply
// genuinely cannot be written — this module owns that:
//
//   * classifyUndeliveredReply() names the ACTUAL reason instead of guessing. The
//     orchestrator's timeout text ("the ComfyUI tab may be backgrounded or frozen") is a
//     guess; the panel knows whether the socket was closed, superseded, or the write
//     threw, and should say so rather than assert a cause nobody established.
//   * a bounded journal keeps those outcomes so the next connection can report them.
//   * shouldReRegister() decides whether to re-advertise (re-hello) this tab, with a hard
//     bound so a wedge can never turn into a re-registration storm.
//
// SAFETY NOTE ON RE-REGISTRATION: re-registering here means re-sending THIS tab's own
// hello for THIS tab's CURRENT active workflow — the same identity the panel already
// re-advertises on a workflow switch (#310/#570). It never selects, guesses, or adopts
// another tab's id. Re-targeting to a different workflow's tab would be wrong-workflow
// corruption, which is strictly worse than staying wedged, so this module deliberately
// exposes no way to choose a target at all.
//
// Dependency-free (no DOM, no sockets, no timers) so it is unit-testable with plain values.

/** How many undelivered command outcomes to retain. Bounded so a tab that spends an hour
 *  disconnected can't grow the journal without limit. */
export const LOST_REPLY_CAP = 12;

/** Hard bound on self-heal re-registrations, per window. A wedge must never become a
 *  hello storm against the orchestrator. */
export const RE_REGISTER_MAX = 3;
export const RE_REGISTER_WINDOW_MS = 60000;

/**
 * Why could this reply not be written? Reports what we OBSERVED, never a guess:
 *
 *  - "socket_closed"     — the socket we received the command on is no longer open. The
 *                          command ran; its answer had nowhere to go.
 *  - "socket_superseded" — a newer socket replaced this one mid-command (reload /
 *                          reconnect / soft reload). Same story, different trigger.
 *  - "send_failed"       — the socket claimed to be open and the write still threw.
 *  - null                — delivered; nothing to report.
 */
export function classifyUndeliveredReply({
  socketOpen = false,
  superseded = false,
  sendThrew = false,
} = {}) {
  if (sendThrew) return "send_failed";
  if (!socketOpen) return superseded ? "socket_superseded" : "socket_closed";
  if (superseded) return "socket_superseded";
  return null;
}

/** Human-readable, cause-specific line for an undelivered reply. Deliberately states
 *  what happened to the REPLY and what is known about the COMMAND separately — the
 *  command having run is not in doubt; only the caller hearing about it is. */
export function describeUndeliveredReply(entry) {
  if (!entry) return "";
  const cmd = entry.cmd || "a command";
  const what = entry.ok ? "completed" : "failed";
  const why =
    entry.reason === "socket_superseded"
      ? "the bridge connection was replaced mid-command (reload/reconnect)"
      : entry.reason === "send_failed"
        ? "writing the reply to the bridge failed"
        : "the bridge connection closed mid-command";
  return (
    `The panel ${what} "${cmd}" but could not send the result back — ${why}. ` +
    `The agent will have seen this as an unknown outcome, not as a failure to act.`
  );
}

/** Bounded journal of command outcomes whose reply could not be delivered. */
export function createLostReplyJournal({ cap = LOST_REPLY_CAP } = {}) {
  const limit = Number.isFinite(cap) && cap > 0 ? cap : LOST_REPLY_CAP;
  let entries = [];
  return {
    /** Record one undelivered outcome. `reply` is the exact frame we failed to send, so
     *  it can be re-sent verbatim on the next socket: rids are random UUIDs, so an
     *  orchestrator that no longer knows the rid simply drops it, and one that still has
     *  the command pending resolves it with its TRUE outcome. */
    record({ reply, cmd, reason, at = 0 } = {}) {
      if (!reply || typeof reply !== "object" || typeof reply.rid !== "string") return null;
      const entry = {
        rid: reply.rid,
        cmd: typeof cmd === "string" && cmd ? cmd : "unknown",
        ok: Boolean(reply.ok),
        reason: typeof reason === "string" && reason ? reason : "socket_closed",
        at: Number.isFinite(at) ? at : 0,
        reply,
      };
      entries.push(entry);
      while (entries.length > limit) entries.shift();
      return entry;
    },
    /** Non-destructive view (newest last). */
    list() {
      return entries.slice();
    },
    /** Wire summaries — the raw `reply` payload is NOT included (it can be large and the
     *  summary is only meant to say WHICH outcomes were lost). */
    summaries() {
      return entries.map(({ rid, cmd, ok, reason, at }) => ({ rid, cmd, ok, reason, at }));
    },
    /** Take everything and empty the journal (used when replaying onto a new socket, so
     *  a replay can never loop). */
    drain() {
      const out = entries;
      entries = [];
      return out;
    },
    size() {
      return entries.length;
    },
  };
}

/** Drop attempt timestamps older than `windowMs`. Returns a NEW array. */
export function pruneAttempts(attempts, now, windowMs = RE_REGISTER_WINDOW_MS) {
  if (!Array.isArray(attempts)) return [];
  if (!Number.isFinite(now)) return attempts.slice();
  const span = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : RE_REGISTER_WINDOW_MS;
  return attempts.filter((t) => Number.isFinite(t) && now - t < span);
}

/**
 * May the panel re-register (re-hello) this tab right now?
 *
 * True only when there is a live socket to hello on AND fewer than `max` re-registrations
 * have already happened inside `windowMs`. Everything else — no socket, budget spent,
 * nothing actually lost — is false, so the wedge is surfaced to the user instead of being
 * papered over with an unbounded retry loop.
 */
export function shouldReRegister({
  socketOpen = false,
  lostCount = 0,
  attempts = [],
  now = 0,
  max = RE_REGISTER_MAX,
  windowMs = RE_REGISTER_WINDOW_MS,
} = {}) {
  if (!socketOpen) return false;
  if (!Number.isFinite(lostCount) || lostCount <= 0) return false;
  const limit = Number.isFinite(max) && max > 0 ? max : RE_REGISTER_MAX;
  return pruneAttempts(attempts, now, windowMs).length < limit;
}

/** The user-facing line for when self-heal is EXHAUSTED — an explicit, actionable next
 *  step, which is the whole point of #508's "a row of identical timeouts is a terrible
 *  failure mode". */
export function reRegisterExhaustedHint() {
  return (
    "The panel keeps losing command replies even after re-registering this tab with the " +
    "agent. Its commands will look like they timed out. Click Reconnect in the panel " +
    "header (or reload the ComfyUI page) to rebuild the bridge for this tab."
  );
}
