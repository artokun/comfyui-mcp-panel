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
  let programmatic = [];
  let disposed = false;

  const clearPendingTimer = () => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };

  const clearProgrammatic = () => {
    for (const scroll of programmatic) {
      if (scroll.timer !== null) clearTimeout(scroll.timer);
    }
    programmatic = [];
  };

  const clearPending = () => {
    pending = false;
    clearPendingTimer();
  };

  return {
    note(event) {
      if (disposed) return;
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
      if (disposed) return;
      // A smooth jump can also schedule an instant stabilizer pass. Keep the
      // longer-lived guard for the same scroll transaction instead of letting
      // that follow-up downgrade it to a one-event guard.
      if (programmatic.some(({ smooth }) => smooth)) return;

      const scroll = { smooth: behavior === "smooth", timer: null };
      scroll.timer = setTimeout(() => {
        const index = programmatic.indexOf(scroll);
        if (index !== -1) programmatic.splice(index, 1);
      }, PROGRAMMATIC_SCROLL_GUARD_MS);
      programmatic.push(scroll);
    },
    endProgrammaticScroll() {
      if (disposed) return;
      const smooth = programmatic.filter(({ smooth }) => smooth);
      for (const scroll of smooth) {
        if (scroll.timer !== null) clearTimeout(scroll.timer);
      }
      programmatic = programmatic.filter(({ smooth }) => !smooth);
    },
    consume() {
      if (disposed) return false;
      if (programmatic.some(({ smooth }) => smooth)) {
        // An app-owned scroll must not spend a genuine user marker. Auto scrolls
        // have one event; smooth scrolls remain guarded until scrollend (or the
        // bounded fallback above).
        return false;
      }
      const autoIndex = programmatic.findIndex(({ smooth }) => !smooth);
      if (autoIndex !== -1) {
        const [scroll] = programmatic.splice(autoIndex, 1);
        if (scroll.timer !== null) clearTimeout(scroll.timer);
        return false;
      }
      const wasPending = pending;
      clearPending();
      return wasPending;
    },
    dispose() {
      disposed = true;
      clearPending();
      clearProgrammatic();
    },
  };
}

export function updateChatStickiness(stickToBottom, { atBottom, userScrollIntent }) {
  if (atBottom) return true;
  return userScrollIntent ? false : stickToBottom;
}
