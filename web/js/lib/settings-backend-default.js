// #1198 — the SETTINGS path commits the durable default before #1184's guard can abort.
//
// #1184 made `connectBackend()` commit nothing until the old provider's session had been
// durably invalidated. It cannot cover the Settings dropdown, because that path commits
// BEFORE `connectBackend` is ever called — and the commit it makes is the durable one:
//
//   Settings combo → ComfyUI writes SETTING_BACKEND → onChange → applyBackend →
//   connectBackend → [#1184's guard aborts]
//
// `SETTING_BACKEND` is the SAVED DEFAULT. It lives in comfy.settings.json, outlives the
// tab, and — unlike `STORAGE_KEY_BACKEND`, which #1184 already leaves untouched on an
// abort — it is not browser-scoped, so it wins on a fresh profile (a different browser,
// a cleared site, an incognito window) where there is no runtime pick to shadow it. The
// panel was left with a durable default naming a backend it had never connected to.
//
// ---------------------------------------------------------------------------
// WHAT COMFYUI ACTUALLY DOES, read from the shipped frontend rather than assumed
// ---------------------------------------------------------------------------
//
// From `src/platform/settings/settingStore.ts` (ComfyUI_frontend 1.50.3, via the
// sourcemap next to the bundle), which `app.ui.settings.setSettingValue` delegates to:
//
//     function applySettingLocally(key, value) {
//       const newValue = tryMigrateDeprecatedValue(settingsById.value[key], cloneDeep(value))
//       const oldValue = get(key)
//       if (newValue === oldValue) return undefined        // (B)
//       onChange(settingsById.value[key], newValue, oldValue)   // (A) — SYNCHRONOUS
//       settingValues.value[key] = typedNewValue
//       return { previousValue: oldValue, newValue: typedNewValue }
//     }
//     async function set(key, value) {
//       const applied = applySettingLocally(key, value)
//       if (applied === undefined) return
//       await api.storeSetting(key, applied.newValue)      // (C) — the SERVER write, LAST
//     }
//
// Three facts fall out, and this module is built on the second and third:
//
//   (A) `onChange` is dispatched SYNCHRONOUSLY, from inside `setSettingValue`, and it is
//       handed the PREVIOUS value as its second argument. The panel's handler ignored that
//       argument; it is the only thing that knows what to restore to, because by the time
//       the switch has finished awaiting, the store has already been overwritten.
//   (B) Writing a value EQUAL to the stored one does nothing at all — no `onChange`, no
//       server write. So a restore is free when there is nothing to restore.
//   (C) The durable (server) write happens AFTER the notification. The issue described the
//       order as "persists, then notifies"; it is the other way round. That does not make
//       the defect go away — `onChange` cannot veto, its return value is discarded, and
//       (C) runs unconditionally once the handler returns — but it is why option 1 in the
//       issue ("validate before ComfyUI persists") is not expressible: there is no
//       pre-change hook, only a notification that is already too late to refuse.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A COMPARE-AND-SWAP, AND WHY THAT IS NOT THE 9181 STORM
// ---------------------------------------------------------------------------
//
// The panel carries a scar from rolling this setting back before. `connectBackend` used to
// call `setSetting(SETTING_BACKEND, id)`, which re-entered through `SETTING_BACKEND.onChange`
// → `applyBackend` → `connectBackend` → `setSetting` → … so each switch overlapped several
// connects and the bridge's close-old-on-new-hello looped. That is the 9181 "ready"/"waiting"
// storm, and `suppressSettingOnChange` is documented as BEST-EFFORT precisely because it is a
// time window: set true, write, set false — which covers the notification only if it is
// delivered synchronously, and nothing in the API promises that.
//
// This module does not re-enter that loop, for two independent reasons:
//
//   1. THE DECISION IS A CAS, and JavaScript makes it atomic for free. `rollback` reads the
//      current value and writes the previous one in ONE synchronous block, so nothing can be
//      interleaved between the read and the write. If the setting no longer holds the value
//      whose switch aborted, somebody else has moved it since and this rollback is stale —
//      it does nothing rather than clobbering a newer pick. That is the entire hazard of a
//      late rollback, and it is closed by construction rather than by timing.
//
//   2. THE ECHO IS IDENTIFIED, NOT SUPPRESSED. `rollback` records the value it is about to
//      write; `isSelfWrite` consumes that record when the matching notification arrives.
//      Because the marker is a VALUE rather than a window, it is correct whether the
//      notification is synchronous (today) or deferred (any future frontend) — which is the
//      thing `suppressSettingOnChange` cannot promise. The marker is self-limiting: the
//      FIRST notification of any kind ends it, so a write that is never notified cannot
//      leave a marker lying in wait to swallow a genuine pick later.
//
// The rollback is also the only `SETTING_BACKEND` write on this path, and it only ever
// writes a value BACKWARDS to one the setting already held. It cannot drive the panel to a
// backend nobody asked for, which is what the old re-entrant write did.

import { BACKEND_SWITCH } from "./backend-switch.js";

/** Why a rollback did or did not happen. For the caller and for tests. */
export const SETTINGS_BACKEND_ROLLBACK = Object.freeze({
  /** The setting was put back to the value it held before the aborted switch. */
  RESTORED: "restored",
  /** The switch was not aborted — the panel really is on the new backend. */
  NOT_ABORTED: "not_aborted",
  /** The setting has moved on since; a stale rollback must not clobber a newer pick. */
  SUPERSEDED: "superseded",
  /** Nothing usable to restore to, so leaving it alone is the lesser wrong. */
  NO_PREVIOUS: "no_previous",
});

/**
 * Decide whether the saved default must be put back, and to what.
 *
 * Pure, so the decision can be tested apart from the write. Every branch is a REFUSAL to
 * write except the last one: a rollback that fires when it should not is worse than the
 * defect it fixes, because it discards a choice the user did make.
 *
 * @param {{
 *   outcome: string,            // the `reason` from `runBackendSwitch`
 *   attempted: string,          // the backend the Settings combo asked for
 *   previous: unknown,          // ComfyUI's `oldValue` — what the setting held before
 *   current: unknown,           // what the setting holds NOW, read in the same tick
 * }} q
 * @returns {{restore: boolean, to: string|null, reason: string}}
 */
export function planSettingsBackendRollback({ outcome, attempted, previous, current } = {}) {
  // OPT IN, never opt out. Only the #1184 abort leaves the panel on a different backend
  // than the setting names; SWITCHED and CONNECTED both mean the panel really is on
  // `attempted`, so the saved default is correct and must stand. A future outcome has to
  // name itself here rather than inherit a rollback by falling through a `!== SWITCHED`.
  if (outcome !== BACKEND_SWITCH.INVALIDATE_FAILED) {
    return { restore: false, to: null, reason: SETTINGS_BACKEND_ROLLBACK.NOT_ABORTED };
  }
  // ComfyUI 1.50.3 always passes `oldValue` (it defaults through `getDefaultValue`, and this
  // setting declares `defaultValue: "claude"`), so this guard is for a frontend that does
  // not. There is deliberately no fallback to `selectedBackend`: the two legitimately
  // diverge — a chip pick moves the runtime backend WITHOUT touching the saved default
  // (that is #1184's FIX 1) — so restoring to it would write a default the user never
  // chose, turning a wrong-default bug into a different wrong-default bug.
  if (typeof previous !== "string" || !previous || previous === attempted) {
    return { restore: false, to: null, reason: SETTINGS_BACKEND_ROLLBACK.NO_PREVIOUS };
  }
  // THE CAS. Read in the same synchronous block as the write that follows, so "still ours"
  // cannot go stale between the two.
  if (current !== attempted) {
    return { restore: false, to: null, reason: SETTINGS_BACKEND_ROLLBACK.SUPERSEDED };
  }
  return { restore: true, to: previous, reason: SETTINGS_BACKEND_ROLLBACK.RESTORED };
}

/**
 * The panel's owner of `SETTING_BACKEND`: it performs the rollback and recognises the
 * notification that rollback causes.
 *
 * @param {{read: () => unknown, write: (value: string) => void}} io
 *   `read`/`write` are the panel's `getSetting`/`setSetting` bound to SETTING_BACKEND.
 */
export function createSettingsBackendDefault({ read, write }) {
  /** The value this module last wrote and has not yet seen come back, or null. */
  let outstanding = null;

  /** A restore that was SUPERSEDED, kept so the switch that superseded it can finish the job.
   *
   *  Two overlapping Settings switches that BOTH abort is not exotic: when the history store
   *  is wedged every switch aborts, so a user who tries twice hits it every time. The second
   *  rollback's `previous` is then the FIRST switch's un-reached backend, and restoring to it
   *  would land the saved default on a backend the panel never connected to — the very
   *  defect this module exists to stop, one step down the chain.
   *
   *  `{displaced, to}` says "the value `displaced` is not a real resting place; anything that
   *  would restore to it should restore to `to` instead". Because `to` is itself resolved
   *  through this table before being stored, a chain of any depth collapses to the last value
   *  the panel actually rested on rather than only unwinding one step. */
  let superseded = null;

  return {
    /**
     * Is this notification the panel's own rollback echoing back?
     *
     * MUST be consulted BEFORE `suppressSettingOnChange`, or the two fight: under today's
     * synchronous dispatch the suppress flag is still true when the echo arrives, so it
     * would swallow the notification and leave `outstanding` set — armed to eat the user's
     * next genuine pick of that backend. Asking here first makes the marker correct under
     * both timings and leaves the suppress flag to the writes that are not ours.
     */
    isSelfWrite(value) {
      if (outstanding === null) return false;
      const mine = outstanding === value;
      // SELF-LIMITING. Either way this notification ends the outstanding write. A different
      // value means ours was superseded before it was ever delivered (or never fired at all,
      // per fact (B)); keeping the marker past that point is how a stale one would later
      // swallow a change the user really made.
      outstanding = null;
      return mine;
    },

    /**
     * Put the saved default back if — and only if — the switch aborted and the setting
     * still holds the value whose switch aborted.
     *
     * @returns {{restore: boolean, to: string|null, reason: string}} what it decided
     */
    rollback({ outcome, attempted, previous } = {}) {
      // Resolve the target through any superseded rollback FIRST. If what we are about to
      // restore to is itself a backend an earlier aborted switch put there, restoring to it
      // would just re-commit an un-reached value.
      const target = superseded && superseded.displaced === previous ? superseded.to : previous;
      const plan = planSettingsBackendRollback({
        outcome,
        attempted,
        previous: target,
        // Read HERE, immediately before the write below, with no await between them.
        current: read(),
      });
      if (plan.reason === SETTINGS_BACKEND_ROLLBACK.SUPERSEDED) {
        // A newer switch is in flight and owns the setting now. Hand it the resting place
        // this rollback could not reach, so that if it also aborts it unwinds the whole
        // chain instead of stopping at this switch's un-reached backend.
        superseded = { displaced: attempted, to: target };
        return plan;
      }
      // Any other outcome settles the question: either the setting is now correct (the
      // switch really happened) or this rollback is about to make it correct. Either way a
      // stale chain must not survive to redirect an unrelated rollback later.
      superseded = null;
      if (!plan.restore) return plan;
      // Marked BEFORE the write, because the write dispatches `onChange` synchronously and
      // the echo therefore arrives during `write(...)`, not after it.
      outstanding = plan.to;
      let wrote = false;
      try {
        write(plan.to);
        wrote = true;
      } finally {
        // Only on a throw. A write that failed produces no notification, so the marker has
        // nothing to consume it and must be dropped here. It is NOT cleared on success —
        // that would be `suppressSettingOnChange`'s time window all over again, and it is
        // exactly what a deferred notification would fall through.
        if (!wrote) outstanding = null;
      }
      return plan;
    },

    /** Test seam: the write still awaiting its notification, if any. */
    outstandingWrite: () => outstanding,
  };
}
