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
 *   1. A WHOLE map was observed, and its observer SAID SO. A per-class `/object_info/<Type>`
 *      payload must never land here: it would make every OTHER type read as absent, and the
 *      ever-seen gate would then diagnose the entire install as removed packs. `record`
 *      cannot judge "whole" from the value, so it requires the claim explicitly (`whole:
 *      true`) and each call site states it. That is not paranoia about a hypothetical:
 *      `assertAddNodeResolvableRefreshing` re-reads the registry across an await and can
 *      hand its SINGLE-CLASS defs to `refresh`, which is the whole-schema path.
 *   2. The socket is UP. `comfyBackendSocketDown` is set by ComfyUI's own `reconnecting`
 *      and null-`status` events. A backend that is down may be restarting, and a restart is
 *      the one event that can change the type set.
 *   3. NO RECONNECT SINCE — measured from when the schema was FETCHED, not when it was
 *      filed. `backendReconnectEpoch` is bumped on every `reconnected`, and `record` takes
 *      the epoch captured BEFORE the request went out, storing nothing if it has moved
 *      since. Reading the epoch at record time instead was a real defect in the first
 *      version of this file: a schema fetched before a restart was filed under post-restart
 *      provenance, and the clear that should have caught it never ran, because the
 *      `reconnected` handler's payload-less `refreshComfyNodeDefs()` is COALESCED into an
 *      in-flight run (`refresh-coalesce.js`) and never reaches `registerComfyNodeDefs`.
 *      That is why the socket handlers now clear this directly rather than trusting the
 *      refresh path to do it. Provenance, not freshness — a snapshot from a replaced
 *      process is refused outright rather than aged out, so there is no time bound to get
 *      wrong.
 *   4. NO SAME-CONNECTION INVALIDATION SINCE — `verifiedNodeDefCache` advances its
 *      generation when a refresh/install/download retires schema proof without a reconnect.
 *      A whole response issued before that event must not be filed under the unchanged epoch,
 *      or the snapshot fallback would resurrect the pre-refresh type set during the next
 *      timeout. `record` therefore takes the generation captured before the request and the
 *      generation at delivery, just as it takes the two epoch values.
 *   5. THE BACKEND NEVER ANSWERED, not merely "the fetch failed". Only outcomes that leave
 *      the question unanswered license the snapshot: a timeout, a client that returned
 *      NOTHING, a proxy's gateway error (which is the proxy reporting the same silence over
 *      HTTP). Anything that ANSWERED — threw, a non-gateway status, an empty schema, a body
 *      that stalled after its headers arrived — keeps the existing refusal.
 *      `TypeError: Failed to fetch` is what a REFUSED connection produces, and a refused
 *      connection is the signature of a process that is gone; silence is the signature of
 *      one that is busy. Conflating them is exactly how this would re-open #458 while
 *      looking like it only relaxed a timeout.
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
 * The value stored against every type name.
 *
 * Frozen and shared: the snapshot answers MEMBERSHIP, and every helper that reads a def's
 * shape treats this as "declares nothing", which is the conservative answer in each case.
 * The map itself is null-prototype so a schema containing a type literally named
 * `__proto__` cannot reach `Object.prototype` — on a plain object that assignment sets the
 * prototype instead of creating an own property, which would both lose the type and poison
 * every object in the page.
 */
const EMPTY_DEF = Object.freeze({});

/**
 * Did the probes fail WITHOUT establishing that the backend answered?
 *
 * TRUE only when at least one route was actually contacted and came back with nothing, and
 * NO route established an answer. An empty or absent list is false: "we recorded nothing"
 * is not evidence of silence, and a caller that lost the outcomes must get the refusal.
 *
 * NOT_ATTEMPTED is neutral — a route nobody asked establishes nothing in either direction,
 * so it neither licenses nor disqualifies. A list of nothing but NOT_ATTEMPTED therefore
 * licenses nothing, which is why the `contacted` flag exists separately.
 */
export function noBackendAnswerEstablished(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) return false;
  let contacted = false;
  for (const entry of outcomes) {
    // An entry this module did not produce is not an outcome it can reason about. Reading
    // an unknown tag as "not an answer" would let a caller license the fallback by handing
    // in anything at all, so an unrecognised shape is disqualifying (codex-style guard).
    const kind = entry && typeof entry === "object" ? entry.kind : undefined;
    if (kind === TRANSPORT_OUTCOME.NO_ANSWER || kind === TRANSPORT_OUTCOME.NOTHING_RETURNED) {
      contacted = true;
      continue;
    }
    if (kind === TRANSPORT_OUTCOME.NOT_ATTEMPTED) continue;
    return false;
  }
  return contacted;
}

/**
 * The last WHOLE `/object_info` map observed on the current backend connection.
 *
 * Deliberately not a second cache. `object-info-cache.js` answers "may this payload be
 * REUSED", on a 1.5s TTL, for the ordinary path. This answers a different question — "is
 * there anything left to authorize from when the backend went quiet" — and it is consulted
 * ONLY after the oracle has already failed.
 *
 * It holds TYPE NAMES, not the schema. See `record` for why that is the detachment as well
 * as the point.
 */
export function createObjectInfoSnapshot() {
  let defs = null;
  let epoch = null;
  let generation = null;
  // #1582 — have the live whole-map routes already gone silent on THIS connection,
  // after a snapshot was held? The first silent call still has to probe: that is how
  // an answered error keeps refusing, and how a healthy backend still wins. Once
  // silence is established, repeating the same 1s+0.5s wait on every widget write is
  // the recurrence — graph reads stay healthy while set_widget stalls on routes that
  // will not answer. Cleared by `record` (a live map means the routes work again)
  // and by `clear` (the connection is no longer the one that went quiet).
  let probesSilent = false;

  return {
    /**
     * Store the type membership of a whole map that was OBSERVED at `observedAtEpoch` and
     * `observedAtGeneration`, if those are still the epoch and schema generation we are on.
     *
     * FOUR THINGS THIS REFUSES, each from a defect found in review:
     *
     * 1. AN EPOCH READ AFTER THE FETCH. `observedAtEpoch` must be captured BEFORE the
     *    request is issued, and is only stored if `currentEpoch` still matches. The first
     *    version stamped the payload with the epoch at RECORD time, so a schema fetched
     *    before a ComfyUI restart was filed under post-restart provenance and would later
     *    authorize a write to a type the new process no longer defines — #458, reopened by
     *    the very field meant to prove it could not be. This is the same generation guard
     *    `object-info-cache.js` uses, and for the same reason: that cache also refuses to
     *    STORE a result issued before an invalidation while still returning it to its
     *    waiter, so a caller passing that answer here must not be able to promote it into a
     *    store with no TTL at all.
     * 2. A PAYLOAD NOBODY VOUCHED FOR. `whole` must be passed explicitly. A per-class
     *    `/object_info/<Type>` payload reaching here would make every other type read as
     *    absent and the ever-seen gate diagnose the whole install as removed packs, and
     *    that payload CAN reach the refresh path (`assertAddNodeResolvableRefreshing`
     *    re-reads the registry across an await and may hand its single-class defs to
     *    `refresh`). The flag makes each call site state the claim rather than imply it.
     * 3. A RESPONSE THAT SPANNED A SAME-EPOCH INVALIDATION. The verified node-definition
     *    cache generation is the panel's schema invalidation fence; epoch equality alone is
     *    insufficient when refresh_nodes clears proof on the same backend connection.
     * 4. ANYTHING THAT COULD NOT AUTHORIZE A WRITE ANYWAY — null, empty, an array, a
     *    non-object, or an unreadable shape.
     *
     * WHAT IS STORED IS A DETACHED MAP OF TYPE NAMES, never the payload. `registerNodesFromDefs`
     * runs `beforeRegisterNodeDef` hooks that mutate definitions IN PLACE — Comfy's own
     * upload hook adds an input the backend never declared — so retaining the payload by
     * reference would let the snapshot hand back frontend-mutated data as backend evidence.
     * Copying the key names is both the detachment and the whole of what this is for: the
     * fence asks "does the backend define this type", nothing more. It also keeps a
     * ~5.4MB schema from being pinned in memory for the life of a connection, and it means
     * the values cannot supply stale combo option lists to anything downstream.
     */
    record(
      candidate,
      {
        observedAtEpoch,
        currentEpoch,
        observedAtGeneration,
        currentGeneration,
        whole = false,
      } = {},
    ) {
      if (whole !== true) return false;
      if (!Number.isFinite(observedAtEpoch) || !Number.isFinite(currentEpoch)) return false;
      if (observedAtEpoch !== currentEpoch) return false;
      if (!Number.isFinite(observedAtGeneration) || !Number.isFinite(currentGeneration)) return false;
      if (observedAtGeneration !== currentGeneration) return false;
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      let keys;
      try {
        // `Object.keys` invokes a Proxy's ownKeys trap, which can throw — the same hazard
        // `usableDefs` guards in the oracle. A payload whose shape cannot be inspected is
        // not one to authorize from.
        keys = Object.keys(candidate);
      } catch {
        return false;
      }
      if (keys.length === 0) return false;
      // One shared frozen value for every key. The fence reads membership via
      // `hasOwnProperty`; the helpers that read a def's SHAPE (uploadInputConfig,
      // serverDeclaresEmptyComboOptions, refreshComboOptionsFromDefs) all return
      // null/false/no-op on this, which is the conservative answer and, for the combo
      // refresh, the difference between "changes nothing" and "rewrites the live dropdown
      // backwards to a stale list".
      const detached = Object.create(null);
      for (const key of keys) detached[key] = EMPTY_DEF;
      defs = Object.freeze(detached);
      // `currentEpoch` and `observedAtEpoch` are provably equal here — the guard above
      // returned false otherwise — so writing either is the same store. Mutation testing
      // reports the swap as a SURVIVOR for exactly that reason; it is an equivalent mutant,
      // not a hole in the suite, and it is recorded here so the next run does not re-chase
      // it. `currentEpoch` is written because it is the one `authorize` compares against.
      epoch = currentEpoch;
      generation = currentGeneration;
      // A live observation means the whole-map routes answered. The next widget write
      // must be allowed to prefer that live path rather than inheriting a prior silence.
      probesSilent = false;
      return true;
    },

    /**
     * The map to authorize from, or null with the reason it was refused.
     *
     * The reason is for the refusal message, so it names the condition that failed rather
     * than the general shape of the rule — a caller told "no snapshot" when the real cause
     * was a reconnect goes looking in the wrong place (#982's lesson).
     *
     * `requireSilence` defaults true: the first fallback still needs the transports to
     * establish that the backend never answered. Pass `false` only after
     * `shouldSkipProbe` has already recorded that silence on this connection (#1582), so
     * a later write can reuse the held map without minting fake outcomes.
     */
    authorize(options = {}) {
      const {
        epoch: currentEpoch,
        socketDown,
        outcomes,
        requireSilence = true,
      } = options;
      // The default keeps standalone snapshot callers source-compatible; every shipped
      // panel caller passes the live generation explicitly. A caller with no generation
      // authority must not be able to choose a different generation by omission.
      const currentGeneration = Object.prototype.hasOwnProperty.call(options, "generation")
        ? options.generation
        : generation;
      if (requireSilence !== false && !noBackendAnswerEstablished(outcomes)) {
        return {
          defs: null,
          reason:
            "the backend ANSWERED the schema probe with something unusable rather than failing " +
            "to answer at all, so this is not the transient silence the last-observed schema covers",
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
      if (!Number.isFinite(currentGeneration) || currentGeneration !== generation) {
        return {
          defs: null,
          reason:
            "the node-definition schema was refreshed since that whole map was observed, " +
            "so the last-observed snapshot is no longer authority",
        };
      }
      return { defs, reason: "" };
    },

    /**
     * Is this snapshot current enough to shorten the next probe budget, or to skip a
     * later probe after silence has already been established?
     *
     * This does not authorize anything and does not expose the names-only map. The first
     * `authorize` call still requires the transport outcome to establish silence, preserving
     * the distinction between a busy backend and one that answered with an unusable schema.
     * The same socket/epoch fence is used so a reconnect cannot inherit the shorter budget
     * or the skip.
     */
    isReusable(options = {}) {
      const { epoch: currentEpoch, socketDown } = options;
      const currentGeneration = Object.prototype.hasOwnProperty.call(options, "generation")
        ? options.generation
        : generation;
      return (
        defs !== null &&
        !socketDown &&
        Number.isFinite(currentEpoch) &&
        currentEpoch === epoch &&
        Number.isFinite(currentGeneration) &&
        currentGeneration === generation
      );
    },

    /**
     * Remember that the live whole-map routes went silent while this snapshot was held.
     *
     * No-op when nothing is held: silence without a map must not license a later skip.
     */
    markProbesSilent() {
      if (defs !== null) probesSilent = true;
    },

    /**
     * May the next ordinary set_widget skip live whole-map probes?
     *
     * True only after `markProbesSilent` on a still-reusable snapshot. The first silent
     * call still probes so an answered error can refuse; a reconnect, a down socket, or a
     * later live `record` all return false.
     */
    shouldSkipProbe(options = {}) {
      const { epoch: currentEpoch, socketDown } = options;
      const reusableOptions = { epoch: currentEpoch, socketDown };
      if (Object.prototype.hasOwnProperty.call(options, "generation")) {
        reusableOptions.generation = options.generation;
      }
      return probesSilent === true && this.isReusable(reusableOptions);
    },

    /** Drop it — for anything that knows, or merely suspects, the schema moved. */
    clear() {
      defs = null;
      epoch = null;
      generation = null;
      probesSilent = false;
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
