// The "Generated media in chat" setting (panel#2034).
//
// THE REQUEST. Every executed image/video/audio output paints a card into the
// chat transcript. Long video work wants the log text-only. This setting is
// that switch — not "Video previews in chat", which only chooses live <video>
// vs a first-frame placeholder and still posts the card.
//
// SCOPE. Cards only. Agent-visible inlineImages/videos/storyboard/completion
// frames keep flowing. Skipping paint skips recordMedia (the painters record
// as they paint), so a suppressed card is not replayed on reload.
//
// DEFAULT ON. Only an explicit stored `false` hides cards. A missing or
// unreadable settings store (getSetting answers undefined) must never silently
// hide output, so anything that is not a stored `false` keeps the cards.
export function chatMediaEnabled(settingValue) {
  return settingValue !== false;
}
