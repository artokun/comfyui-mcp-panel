// #1289 — dictate in the language the panel is speaking, not whatever the browser says.
//
// ## The defect
//
// The composer set `recognition.lang = navigator.language || "en-US"`. A user who set the
// panel (or ComfyUI itself) to French while their browser reports en-US dictated French
// into an English recognizer and got garbage back. The panel had ALREADY resolved which
// language it is speaking — pickLocale's explicit-setting → ComfyUI-locale → navigator
// order — and dictation ignored all of it.
//
// ## What this module does
//
// One precedence, stated once: the panel's own resolved locale wins; the browser's
// language is the fallback for a panel that has not resolved one yet; "en-US" is the
// floor so `lang` is never an empty string (an empty BCP-47 tag is a silent
// implementation-defined default, which is how this bug looked from the inside).
// The panel's codes ("pt-BR", "zh-TW", bare "zh") are all valid BCP-47 tags, so no
// remapping happens here — the locale is passed through, not reinterpreted.

/**
 * The BCP-47 tag to hand SpeechRecognition: the panel's resolved locale first, the
 * browser's language second, "en-US" last.
 */
export function voiceRecognitionLang({ panelLocale, browserLang } = {}) {
  return panelLocale || browserLang || "en-US";
}
