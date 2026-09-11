/** Close a reasoning-only segment without waiting for a text commit. */
export function finishThoughtStream(id, streams, animating, collapse, label) {
  const state = streams.get(id);
  if (!state || state.commitText !== null || !state.thinkBody) return false;
  state.thinkBody.textContent = state.thinkTarget;
  state.thinkShown = state.thinkTarget.length;
  animating.delete(state);
  streams.delete(id);
  state.el.classList.remove("streaming");
  state.replyEl.classList.remove("streaming-cursor");
  collapse(state, label);
  return true;
}

/** A marker can arrive before the typewriter has persisted the message. */
export function createProcessPresentation(wrap, changed) {
  const messages = new Map();
  const trim = () => { while (messages.size > 1000) messages.delete(messages.keys().next().value); };
  const apply = (state) => {
    if (!state.process || !state.entry || !state.element) return;
    wrap(state.element);
    if (state.entry.executionProcess !== true) {
      state.entry.executionProcess = true;
      changed(state.entry);
    }
  };
  return {
    register(id, element, entry) {
      if (!id || !element || !entry) return;
      const state = messages.get(id) || {};
      Object.assign(state, { element, entry });
      messages.set(id, state); apply(state); trim();
    },
    mark(id) {
      if (typeof id !== "string" || !id) return;
      const state = messages.get(id) || {};
      state.process = true;
      messages.set(id, state); apply(state); trim();
    },
    clear() { messages.clear(); },
  };
}
