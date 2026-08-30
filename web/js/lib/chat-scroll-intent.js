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

const LEAVING_BOTTOM_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

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

// True when the gesture is trying to reveal earlier transcript (decrease scrollTop).
// Distinct from isUserScrollIntent: a downward wheel to the latest message must
// still re-stick, and a pointerdown on a card is not itself a leave-bottom.
export function isLeavingBottomScrollIntent(event) {
  if (!event) return false;
  if (event.ctrlKey) return false;
  if (event.type === "wheel") return Number(event.deltaY) < 0;
  if (event.type === "touchmove" && typeof event.deltaY === "number") return event.deltaY < 0;
  return event.type === "keydown" && LEAVING_BOTTOM_KEYS.has(event.key);
}

export function createChatScrollIntentTracker() {
  let pending = false;
  let pendingLeave = false;
  let pendingTimer = null;
  let lastTouchY = null;
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
    pendingLeave = false;
    clearPendingTimer();
  };

  return {
    note(event) {
      if (disposed) return;
      let touchLeaving = false;
      if (event?.type === "touchmove") {
        const y = event.touches?.[0]?.clientY;
        if (typeof y === "number") {
          touchLeaving = lastTouchY != null && y > lastTouchY;
          lastTouchY = y;
        }
      } else {
        lastTouchY = null;
      }
      if (!isUserScrollIntent(event)) return;
      // A new user event owns the next scroll transaction, even if it interrupts
      // an in-flight smooth programmatic scroll.
      clearProgrammatic();
      pending = true;
      pendingLeave = isLeavingBottomScrollIntent(event) || touchLeaving;
      clearPendingTimer();
      pendingTimer = setTimeout(() => {
        pending = false;
        pendingLeave = false;
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
    consumeIntent() {
      if (disposed) return { userScrollIntent: false, leavingBottom: false };
      if (programmatic.some(({ smooth }) => smooth)) {
        // An app-owned scroll must not spend a genuine user marker. Auto scrolls
        // have one event; smooth scrolls remain guarded until scrollend (or the
        // bounded fallback above).
        return { userScrollIntent: false, leavingBottom: false };
      }
      const autoIndex = programmatic.findIndex(({ smooth }) => !smooth);
      if (autoIndex !== -1) {
        const [scroll] = programmatic.splice(autoIndex, 1);
        if (scroll.timer !== null) clearTimeout(scroll.timer);
        return { userScrollIntent: false, leavingBottom: false };
      }
      const intent = { userScrollIntent: pending, leavingBottom: pendingLeave };
      clearPending();
      return intent;
    },
    consume() {
      return this.consumeIntent().userScrollIntent;
    },
    hasPending() {
      return !disposed && pending;
    },
    hasLeavingBottom() {
      return !disposed && pendingLeave;
    },
    clearUserIntent() {
      if (disposed) return;
      lastTouchY = null;
      clearPending();
    },
    dispose() {
      disposed = true;
      lastTouchY = null;
      clearPending();
      clearProgrammatic();
    },
  };
}

export function updateChatStickiness(stickToBottom, { atBottom, userScrollIntent, leavingBottom = false }) {
  // An upward user gesture must unstick even while still inside BOTTOM_SLACK_PX.
  // Re-sticking there lets streaming/stabilizer writes overwrite each wheel tick
  // and the transcript never leaves the pin.
  if (userScrollIntent && leavingBottom) return false;
  if (atBottom) return true;
  return userScrollIntent ? false : stickToBottom;
}
