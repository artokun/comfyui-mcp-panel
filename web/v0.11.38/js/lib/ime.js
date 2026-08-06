// Shared IME (Input Method Editor) composition guard for keydown handlers.
//
// While a CJK IME (Korean 2-beolsik, Japanese, Chinese, …) is composing a
// syllable, the keystroke that COMMITS the composition also fires a `keydown`
// with `key === "Enter"`. A composer/menu handler that treats that Enter as
// "submit" sends the in-flight text early and then leaks the still-composing
// final syllable into the now-empty field, which is sent as a stray one-char
// message on the next Enter (issue #385). Arrow/Tab keys are likewise owned by
// the IME candidate window during composition and must not be hijacked.
//
// `event.isComposing` is the standard signal, but it can be false on the very
// first/last keydown of a composition in some engines, so we also check the
// legacy `keyCode === 229` sentinel that every major browser still emits while
// an IME is processing a key. A handler should call this FIRST and bail out
// (return early) when it is true, letting the IME own the keystroke.
export function isImeComposing(ev) {
  return !!(ev && (ev.isComposing || ev.keyCode === 229));
}
