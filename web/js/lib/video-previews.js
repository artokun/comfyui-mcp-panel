// The "Video previews in chat" setting (panel#1280).
//
// THE REQUEST. Every generated video lands in the chat transcript as a live,
// autoplaying <video> (the lazy holder in the panel keeps the decode to
// on-screen cards, but on-screen still means decoded). Long or numerous outputs
// make that expensive, so the setting lets a user opt OUT: the card becomes a
// metadata-only placeholder (first frame + filename) and the full video stays
// one click away in the lightbox.
//
// WHY A MODULE. The read happens inside the panel's DOM closure, which is not
// importable from a unit test; the DECISION is. One question, one answer:
//
// DEFAULT ON. The setting defaults to true and only an explicit `false` turns
// previews off — a missing/unreadable settings store (getSetting answers
// undefined) must never silently change what a returning user sees, so anything
// that is not a stored `false` means previews stay on.
export function videoPreviewsEnabled(settingValue) {
  return settingValue !== false;
}
