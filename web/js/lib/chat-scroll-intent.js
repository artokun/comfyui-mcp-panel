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

export function isUserScrollIntent(event) {
  if (!event) return false;
  if (event.type === "wheel" || event.type === "touchmove" || event.type === "pointerdown") return true;
  return event.type === "keydown" && VERTICAL_SCROLL_KEYS.has(event.key);
}

export function createChatScrollIntentTracker() {
  let pending = false;

  return {
    note(event) {
      if (isUserScrollIntent(event)) pending = true;
    },
    consume() {
      const wasPending = pending;
      pending = false;
      return wasPending;
    },
  };
}

export function updateChatStickiness(stickToBottom, { atBottom, userScrollIntent }) {
  if (atBottom) return true;
  return userScrollIntent ? false : stickToBottom;
}
