/**
 * #1223 — a TRANSIENT `/object_info` timeout must not refuse a safe widget edit.
 *
 * Reported: `panel_set_widget` refused a live edit on an existing `H3Keyframes` node
 * because BOTH probes timed out — `api.getNodeDefs()` and `GET /object_info`. The canvas
 * was reachable and `panel_disconnect` mutations had succeeded moments earlier, so nothing
 * about the session was broken; the schema fetch simply did not come back in time. The
 * refusal reads as "cannot verify the node type against the ComfyUI backend", which is
 * true, and useless: the agent is told a write is unsafe when the only thing established
 * is that a download was slow.
 *
 * WHY IT TIMES OUT AT ALL, since "the backend is fine" and "20s of silence" sound
 * contradictory. ComfyUI serves HTTP from the same process that runs the graph, so a heavy
 * step (a VAE decode, a model load) blocks the event loop and `/object_info` — megabytes on
 * a large install — waits behind it. That is a BUSY backend, not an absent one, and it is
 * the ordinary condition during a render.
 *
 * WHAT MUST NOT BE WEAKENED. `assertTypeAgainstFreshBackend` fails closed on a null map
 * because of #458: the LiteGraph registry keeps a STALE POSITIVE for an uninstalled pack
 * when the tab was never reloaded after a ComfyUI restart, so the registry is not a trust
 * root and a write authorized from it fabricates success against a backend that no longer
 * defines the type. Nothing here may re-open that.
 *
 * THE TRUST ROOT THIS USES INSTEAD, and why a stale cache cannot forge it. A ComfyUI
 * process cannot change the set of types it serves without RESTARTING — `NODE_CLASS_MAPPINGS`
 * is built at import time, and installing, uninstalling or disabling a pack (through the
 * Manager or by hand) only takes effect on the next boot. A restart drops this tab's
 * websocket. So a `/object_info` map observed on the CURRENT backend connection still
 * describes the process that is answering now, and this authorizes from that map — never
 * from the registry, which carries no such provenance.
 *
 * FOUR CONDITIONS, ALL REQUIRED, all fail-closed:
 *
 *   1. A WHOLE map was observed and stored. A per-class `/object_info/<Type>` payload must
 *      never land here: it would make every OTHER type read as absent, and the ever-seen
 *      gate would then diagnose the entire install as removed packs. `record` cannot
 *      enforce "whole" from the value alone, so its callers are the contract — see
 *      `recordsWholeSchemaOnly` in the panel and the test that pins it.
 *   2. The socket is UP. `comfyBackendSocketDown` is set by ComfyUI's own `reconnecting`
 *      and null-`status` events. A backend that is down may be restarting, and a restart is
 *      the one event that can change the type set.
 *   3. NO RECONNECT SINCE. `backendReconnectEpoch` is bumped on every `reconnected`. A
 *      snapshot from an earlier epoch describes a process that has been replaced, so it is
 *      refused outright rather than aged out — this is provenance, not freshness, and a
 *      time bound would answer a question nobody asked.
 *   4. THE PROBES WERE SILENT, not merely unsuccessful. This is the narrow one, and it is
 *      deliberately narrower than "the fetch failed": only `no-answer` (and never-contacted)
 *      outcomes license the snapshot. Anything that ANSWERED — threw, a non-OK status, an
 *      empty schema, a body that stalled after its headers arrived — keeps the existing
 *      refusal. `TypeError: Failed to fetch` is what a REFUSED connection produces, and a
 *      refused connection is the signature of a process that is gone; silence is the
 *      signature of one that is busy. Conflating them is exactly how this would re-open
 *      #458 while looking like it only relaxed a timeout.
 *
 * WHAT THIS DOES NOT CLOSE, stated rather than glossed. Conditions 2 and 3 both rest on the
 * tab NOTICING that the socket went away. A half-open TCP connection to a process that has
 * already died does not report itself, and in that window the probes time out (condition 4
 * is satisfied), the socket reads as up, and the epoch has not moved — so a snapshot could
 * authorize a write to a type the NEXT process will not define. That requires the restart
 * AND a pack removal across it AND a write to that exact type inside the window. The
 * direction matters and is the same one `object-info-cache.js` records for its own 1.5s
 * window: an INSTALL is harmless here (a type missing from the snapshot is still refused,
 * which fails closed), only a REMOVAL can authorize something it should not, and the tab's
 * own reconnect handler refuses everything from the moment it notices. This widens an
 * existing race rather than opening a new class of hole, and it is written down so whoever
 * weighs it next does not have to rediscover it.
 */

import { TRANSPORT_OUTCOME } from "./object-info-oracle.js";

/**
 * Does what the transports did license authorizing from a stored snapshot?
 *
 * TRUE only when at least one route was SILENT and no route ANSWERED. An empty or absent
 * list is false: "we recorded nothing" is not evidence of silence, and a caller that lost
 * the outcomes must get the refusal, not the fallback.
 */
export function transportsWereSilent(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) return false;
  let sawSilence = false;
  for (const entry of outcomes) {
    // An entry this module did not produce is not an outcome it can reason about. Reading
    // an unknown tag as "not an answer" would let a caller license the fallback by handing
    // in anything at all, so an unrecognised shape is disqualifying (codex-style guard).
    const kind = entry && typeof entry === "object" ? entry.kind : undefined;
    if (kind === TRANSPORT_OUTCOME.NO_ANSWER) {
      sawSilence = true;
      continue;
    }
    if (kind === TRANSPORT_OUTCOME.NOT_ATTEMPTED) continue;
    return false;
  }
  return sawSilence;
}

/**
 * The last WHOLE `/object_info` map observed on the current backend connection.
 *
 * Deliberately not a second cache. `object-info-cache.js` answers "may this payload be
 * REUSED", on a 1.5s TTL, for the ordinary path. This answers a different question — "is
 * there anything left to authorize from when the backend went quiet" — and it is consulted
 * ONLY after the oracle has already failed.
 */
export function createObjectInfoSnapshot() {
  let defs = null;
  let epoch = null;

  return {
    /**
     * Store a whole map observed at `atEpoch`.
     *
     * Rejects anything that could not authorize a write anyway (null, empty, an array, a
     * non-object) and any epoch that is not a finite number — an unusable epoch cannot be
     * compared later, and a snapshot that cannot prove its provenance is worse than none.
     */
    record(candidate, atEpoch) {
      if (!Number.isFinite(atEpoch)) return false;
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      let size = 0;
      try {
        // `Object.keys` invokes a Proxy's ownKeys trap, which can throw — the same hazard
        // `usableDefs` guards in the oracle. A payload whose shape cannot be inspected is
        // not one to authorize from.
        size = Object.keys(candidate).length;
      } catch {
        return false;
      }
      if (size === 0) return false;
      defs = candidate;
      epoch = atEpoch;
      return true;
    },

    /**
     * The map to authorize from, or null with the reason it was refused.
     *
     * The reason is for the refusal message, so it names the condition that failed rather
     * than the general shape of the rule — a caller told "no snapshot" when the real cause
     * was a reconnect goes looking in the wrong place (#982's lesson).
     */
    authorize({ epoch: currentEpoch, socketDown, outcomes } = {}) {
      if (!transportsWereSilent(outcomes)) {
        return {
          defs: null,
          reason:
            "the backend ANSWERED the schema probe with something unusable rather than going " +
            "silent, so this is not the transient timeout the last-observed schema covers",
        };
      }
      if (defs === null) {
        return {
          defs: null,
          reason: "no whole /object_info has been observed on this backend connection yet",
        };
      }
      if (socketDown) {
        return {
          defs: null,
          reason:
            "the ComfyUI socket is down — the backend may be restarting, which is the one " +
            "event that can change the node types it defines",
        };
      }
      if (!Number.isFinite(currentEpoch) || currentEpoch !== epoch) {
        return {
          defs: null,
          reason:
            "the backend reconnected since that schema was observed, so it describes a " +
            "ComfyUI process that has been replaced",
        };
      }
      return { defs, reason: "" };
    },

    /** Drop it — for anything that knows, or merely suspects, the schema moved. */
    clear() {
      defs = null;
      epoch = null;
    },

    /** Test/diagnostic view. Never used to make a decision. */
    peek() {
      return { held: defs !== null, epoch };
    },
  };
}

/**
 * The sentence a SUCCESSFUL write appends when it was authorized from the snapshot.
 *
 * A write that succeeded on a schema nobody could re-fetch must say so. The agent's next
 * decision — retry, or trust this and move on — depends on knowing the backend went quiet,
 * and a silent success is indistinguishable from a fully verified one.
 */
export function snapshotAuthorizationNote(failureNote = "") {
  return (
    `The write SUCCEEDED and was verified against the last whole /object_info observed on ` +
    `this ComfyUI connection: the live schema probe went silent, so it was authorized from ` +
    `that snapshot instead (#1223).${failureNote} The backend has not reconnected since that ` +
    `schema was read, so it still describes the process answering now — but if the node type ` +
    `matters to what happens next, re-read it once ComfyUI is responding again.`
  );
}
