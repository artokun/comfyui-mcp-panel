const VERTICAL_SCROLL_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
  "Spacebar",
]);

// Chromium dispatches a user wheel event before its scroll event, but the scroll
// can land on the next rendering opportunity. Keep the association long enough
// for that browser ordering without allowing an input that did not scroll to
// authorize a later content-visibility/anchoring scroll.
const USER_SCROLL_INTENT_EXPIRY_MS = 100;
const PROGRAMMATIC_SCROLL_GUARD_MS = 1000;

export function isUserScrollIntent(event) {
  if (!event) return false;
  if (event.type === "wheel" || event.type === "touchmove" || event.type === "pointerdown") return true;
  return event.type === "keydown" && VERTICAL_SCROLL_KEYS.has(event.key);
}

export function createChatScrollIntentTracker() {
  let pending = false;
  let pendingTimer = null;
  let programmatic = null;

  const clearPendingTimer = () => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };

  const clearProgrammatic = () => {
    if (programmatic?.timer !== null && programmatic?.timer !== undefined) {
      clearTimeout(programmatic.timer);
    }
    programmatic = null;
  };

  const clearPending = () => {
    pending = false;
    clearPendingTimer();
  };

  return {
    note(event) {
      if (!isUserScrollIntent(event)) return;
      // A new user event owns the next scroll transaction, even if it interrupts
      // an in-flight smooth programmatic scroll.
      clearProgrammatic();
      pending = true;
      clearPendingTimer();
      pendingTimer = setTimeout(() => {
        pending = false;
        pendingTimer = null;
      }, USER_SCROLL_INTENT_EXPIRY_MS);
    },
    noteProgrammaticScroll({ behavior = "auto" } = {}) {
      // A smooth jump can also schedule an instant stabilizer pass. Keep the
      // longer-lived guard for the same scroll transaction instead of letting
      // that follow-up downgrade it to a one-event guard.
      if (programmatic?.smooth && behavior !== "smooth") return;
      clearProgrammatic();
      if (behavior === "smooth") {
        const timer = setTimeout(() => {
          programmatic = null;
        }, PROGRAMMATIC_SCROLL_GUARD_MS);
        programmatic = { smooth: true, timer };
      } else {
        // The next scroll event belongs to this synchronous/auto operation. Do
        // not discard `pending`: a real user scroll may follow it.
        programmatic = { smooth: false, timer: null };
      }
    },
    endProgrammaticScroll() {
      clearProgrammatic();
    },
    consume() {
      if (programmatic) {
        // An app-owned scroll must not spend a genuine user marker. Auto scrolls
        // have one event; smooth scrolls remain guarded until scrollend (or the
        // bounded fallback above).
        if (programmatic.timer === null) clearProgrammatic();
        return false;
      }
      const wasPending = pending;
      clearPending();
      return wasPending;
    },
    dispose() {
      clearPending();
      clearProgrammatic();
    },
  };
}

export function updateChatStickiness(stickToBottom, { atBottom, userScrollIntent }) {
  if (atBottom) return true;
  return userScrollIntent ? false : stickToBottom;
}
