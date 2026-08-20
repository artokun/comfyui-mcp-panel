/**
 * Composer paste routing + orphaned attachment tokens (#1467).
 *
 * Two silent content-loss defects on the chat input path, both of which end with
 * the agent receiving a message the user believes carried more than it did, and
 * NOTHING on screen saying so.
 *
 * 1. A clipboard that carries BOTH a file item and text.
 *    The composer's paste handler took the first `kind:"file"` item, called
 *    preventDefault() and RETURNED — so `text/plain` from the same clipboard was
 *    discarded before anything could look at it, and the browser's own default
 *    insertion was suppressed too. That is not an exotic clipboard: copying rich
 *    content on Windows (Word, Outlook, Excel, PowerPoint, and many web pages)
 *    puts a synthesized bitmap on the clipboard ALONGSIDE the text, which Chrome
 *    surfaces as an `image/png` file item. Pasting a prompt copied out of a
 *    document therefore attached a picture and dropped every character of the
 *    text, with no error and no placeholder.
 *
 *    {@link planComposerPaste} decides both halves at once, so the file branch
 *    can no longer consume the event on the text's behalf. It never answers
 *    "discard": every clipboard flavour the composer claims is either attached
 *    or inserted.
 *
 * 2. An attachment token with no attachment behind it.
 *    A pasted block collapses to a `[Pasted text #N]` token in the composer and
 *    is expanded back to the full text at send. The attachment registry is
 *    CLEARED after every send, but the raw composer text — tokens and all — is
 *    kept for ↑ history recall, the ✎ edit control and the double-Esc rewind.
 *    Re-sending a recalled message therefore ships the bare token: the agent
 *    gets `[Pasted text #1]`, the pasted content is gone, and neither side is
 *    told. {@link orphanAttachmentTokens} names exactly those tokens so the
 *    composer can say so out loud instead.
 *
 * Pure and dependency-free so both decisions are testable without a DOM.
 */

/** Chars; a longer paste collapses to a chip instead of filling the composer. */
export const PASTE_TEXT_THRESHOLD = 800;

/** Newlines; a paste at least this tall collapses to a chip whatever its length. */
export const PASTE_TEXT_LINE_THRESHOLD = 12;

/**
 * Is this paste big enough to collapse into a `[Pasted text #N]` chip rather
 * than land in the composer verbatim? Long OR tall — a 30-line block of short
 * lines is just as unreadable in a 120px textarea as one long paragraph.
 */
export function isLargePaste(text) {
  if (typeof text !== "string" || !text) return false;
  if (text.length > PASTE_TEXT_THRESHOLD) return true;
  return (text.match(/\n/g) || []).length >= PASTE_TEXT_LINE_THRESHOLD;
}

/**
 * What the composer should do with one paste.
 *
 * @param {{hasFile?: boolean, text?: string}} clipboard
 *   `hasFile` — the clipboard carries at least one `kind:"file"` item the
 *   composer can attach; `text` — its `text/plain` flavour (may be empty).
 * @returns {{file: boolean, text: "attach"|"insert"|"none"|"default"}}
 *   `file`   — route the file item through the attachment pipeline.
 *   `text`   — `"attach"`  collapse it to a pasted-text chip;
 *              `"insert"`  put it in the composer at the caret ourselves;
 *              `"none"`    there is no text to place;
 *              `"default"` leave the event alone and let the browser insert it.
 *
 * The `"default"` answer is the ONLY one that does not claim the event, and it
 * is returned only when nothing else about the clipboard is being claimed
 * either — so a caller that honours this shape can never call preventDefault()
 * on a flavour it then fails to place. A file and text are both taken when both
 * are present: which one the user "meant" is not knowable from the clipboard,
 * and guessing is what lost the text in the first place.
 */
export function planComposerPaste({ hasFile = false, text = "" } = {}) {
  const body = typeof text === "string" ? text : "";
  const file = !!hasFile;
  if (isLargePaste(body)) return { file, text: "attach" };
  if (!file) return { file: false, text: "default" };
  // The file branch suppresses the browser's own insertion, so any text that
  // came with it has to be placed by hand or it is gone.
  return { file: true, text: body ? "insert" : "none" };
}

/** The inline token each attachment kind inserts into the composer. */
export const ATTACHMENT_TOKEN_LABELS = Object.freeze({
  image: "Image",
  text: "Pasted text",
  video: "Video",
  textfile: "File",
  file: "File",
  workflow: "Workflow",
});

/** Every attachment token the composer can insert, as it appears in the text. */
export const ATTACHMENT_TOKEN_RE = /\[(Pasted text|Image|Video|File|Workflow) #(\d+)\]/g;

/**
 * The attachment tokens present in `text` that NO live attachment backs.
 *
 * Matching is by (label, id) against the registry, not by id alone: ids are
 * per-message and restart at 1, so `[Image #1]` and `[Pasted text #1]` can both
 * be live at once and a bare id would call one of them resolved on the other's
 * evidence.
 *
 * @param {string} text  the raw composer text about to be sent
 * @param {Array<{id?: any, kind?: string}>} attachments  the live registry
 * @returns {string[]} the orphaned tokens, in the order they appear, deduped
 */
export function orphanAttachmentTokens(text, attachments) {
  if (typeof text !== "string" || !text) return [];
  const live = new Set();
  for (const a of attachments ?? []) {
    const label = ATTACHMENT_TOKEN_LABELS[a?.kind];
    if (label && a?.id != null) live.add(`${label} #${a.id}`);
  }
  const out = [];
  const seen = new Set();
  // A fresh regex per call: ATTACHMENT_TOKEN_RE is global, and a shared lastIndex
  // would make the second call on the same string start half way through it.
  const re = new RegExp(ATTACHMENT_TOKEN_RE.source, "g");
  let m;
  while ((m = re.exec(text)) !== null) {
    const key = `${m[1]} #${m[2]}`;
    if (live.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(m[0]);
  }
  return out;
}
