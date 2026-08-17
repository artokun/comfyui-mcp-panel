// #1288 — turn the Web Speech API's bare error codes into something a user can act on.
//
// ## The defect
//
// SpeechRecognition's `error` event reports an IDENTIFIER, not prose: "network",
// "no-speech", "not-allowed". The composer printed it verbatim — "Voice input error:
// network" — and stopped. In a Chromium fork (Brave, Vivaldi, Arc, the Electron shell
// ComfyUI Desktop runs in) "network" is the USUAL outcome, not a connectivity blip:
// recognition runs on a server-side speech service, and only Google Chrome (Google's
// servers) and Microsoft Edge (Microsoft's) ship with access to one. A fork built
// without the API keys fails every single session, and the bare code sent users
// restarting their router over a failure no router can fix.
//
// ## What this module does
//
// Maps each code to a sentence that says WHAT failed and WHAT to do about it, keeping
// the raw code inside the message for anyone who goes looking. A code with no specific
// guidance still surfaces through the generic form — an unexplained failure is reported,
// never swallowed. The one exception is `aborted`, which means "you pressed stop
// yourself"; it returns null so the caller stays silent.
import { tr } from "./i18n.js";

/**
 * The chat line for a SpeechRecognition `error` event's code, or null when the code
 * does not merit one (only `aborted` today — the user ended the session themselves).
 */
export function describeVoiceError(code) {
  switch (code) {
    case "aborted":
      return null;
    case "network":
      // The code name stays in the text on purpose: it is what a search for the
      // symptom finds, and it keeps the message honest about which failure fired.
      return tr(
        "panel.voice_input_failed_this_browser_could_not",
        'Voice input failed: this browser could not reach its speech-recognition service ("network"). ' +
          "Chromium-based browsers other than Google Chrome and Microsoft Edge ship without one, so " +
          "dictation cannot work here — use Chrome or Edge for voice input.",
      );
    case "not-allowed":
    case "service-not-allowed":
      return tr(
        "panel.voice_input_was_blocked_allow_microphone",
        'Voice input was blocked ("{error}"): allow microphone access for this page and try again.',
        { error: code },
      );
    default:
      return tr("panel.voice_input_error", "Voice input error: {error}", { error: code });
  }
}
