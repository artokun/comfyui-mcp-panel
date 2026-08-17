// #1290 — in the ComfyUI desktop app the mic button must SAY dictation cannot work.
//
// ## The defect
//
// The composer gated the mic button on `window.SpeechRecognition ??
// window.webkitSpeechRecognition` existing. In the desktop app (Electron) the API
// object EXISTS, so the button looked ready — but Electron ships with no speech
// service behind it, and every dictation attempt failed at `start()`. "Supported"
// was being read as "the constructor exists" when the question the user needs
// answered is "is there a backend that can recognize speech".
//
// ## What this module does
//
// Two small verdicts, both pure so the panel's DOM wiring stays thin:
//
//   * `isEmbeddedDesktopShell` — are we inside Electron. Detected the way the rest
//     of the panel already detects it (the `electronAPI` / `comfyAPI.electron`
//     bridge openExternalUrl uses), with the `Electron/` UA token as the belt to
//     the bridge's suspenders.
//   * `voiceInputSupport` — can dictation work HERE, and if not, the one sentence
//     that says why. A desktop shell is unsupported even when the API object
//     exists, and the sentence names the remedy: open ComfyUI in Chrome or Edge.
import { tr } from "./i18n.js";

/**
 * Whether this window is an embedded Electron shell (ComfyUI Desktop). The bridge
 * object is checked first because it cannot lie about its own presence; the UA
 * token covers shells where the bridge was never injected.
 */
export function isEmbeddedDesktopShell({ electronBridge, userAgent } = {}) {
  return Boolean(electronBridge) || /Electron\//.test(userAgent || "");
}

/**
 * Dictation support as `{ supported, title? }`. `title` is the mic button's
 * hover text when unsupported — the button is DISABLED, so the title is the only
 * place the reason can live, and it must say why rather than just "no".
 */
export function voiceInputSupport({ SR, desktopShell } = {}) {
  if (!SR) {
    return {
      supported: false,
      title: tr("panel.voice_input_is_not_supported_in_this", "Voice input is not supported in this browser"),
    };
  }
  if (desktopShell) {
    return {
      supported: false,
      title: tr(
        "panel.voice_input_is_not_available_in_the",
        "Voice input is not available in the ComfyUI desktop app — its embedded browser has no " +
          "speech-recognition service. Open ComfyUI in Chrome or Edge to dictate.",
      ),
    };
  }
  return { supported: true };
}
