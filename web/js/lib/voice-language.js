// #1289 / #1329 — dictate in the language the user is speaking.
//
// ## The defects
//
// #1289: the composer set `recognition.lang = navigator.language || "en-US"`. A user
// who set the panel (or ComfyUI itself) to French while their browser reports en-US
// dictated French into an English recognizer and got garbage back.
//
// #1329: after #1289, dictation used the panel's *resolved* locale. The panel only
// ships [en, zh, zh-TW, ru, ja, ko, fr, es, pt-BR, tr, ar, fa]. pickLocale flattens
// a de-DE (or it, nl, pl, sv, …) browser to the "en" floor because there is no
// German catalog. Dictation does not need a translation catalog — a German speaker
// then gets an English recognizer with no setting that can fix it.
//
// ## What this module does
//
// One precedence, stated once:
//   1. A resolved panel locale that is NOT the "en" fallback floor wins (keeps
//      #1289: a French panel + English browser still dictates French).
//   2. When the panel is the "en" floor (or unresolved) and the browser reports a
//      non-English language, trust the browser — that is the spoken language.
//   3. Otherwise panel locale, then browser language, then "en-US" so `lang` is
//      never an empty string.
// The panel's codes ("pt-BR", "zh-TW", bare "zh") are all valid BCP-47 tags, so no
// remapping happens here — the locale is passed through, not reinterpreted.

/**
 * The BCP-47 tag to hand SpeechRecognition.
 *
 * A non-English panel locale wins. The "en" panel floor does not override a
 * non-English browser language (#1329). "en-US" is last so lang is never empty.
 */
export function voiceRecognitionLang({ panelLocale, browserLang } = {}) {
  // Dictation needs the user's SPOKEN language, which is not limited to the locales the
  // panel ships translations for. When the panel resolved to "en" merely as the fallback
  // floor (the user's language, e.g. German, is not a shipped panel locale) while the
  // browser reports a non-English language, trust the browser for dictation -- a German
  // speaker dictating into an English recognizer gets garbage back.
  if (panelLocale && panelLocale !== "en") return panelLocale;
  if (browserLang && !/^en(-|$)/i.test(browserLang)) return browserLang;
  return panelLocale || browserLang || "en-US";
}
