/**
 * #756 — a chat attachment upload that fails must say WHAT was observed.
 *
 * Both upload paths (`handleImageFile`, `handleMediaUpload`) POST to
 * `/upload/image` and then threw the outcome away twice over: a non-200 had no
 * `else` at all, and the `catch` was bare. The agent received the string
 * `upload failed` and nothing else — no status, no size, no MIME type, no
 * exception. Two .mp4 attachments failed while a 1.5 MB .png had succeeded
 * minutes earlier in the same session, and neither the reporter nor anyone
 * reading the report could tell whether to retry, shrink, re-encode, or use a
 * different path. The cause was discarded at both points where it was known.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: name a cause. A 413 is evidence about
 * size, a 400 usually carries ComfyUI's own explanation in the body, and a
 * TypeError is a transport failure — but "the file is too big" is an inference,
 * and inferring one from a status is the same defect as the workflow fence
 * asserting "the workflow was switched" for every mismatch (#750). Report the
 * status, the server's own words when it sent any, and the file's measurements.
 * The reader can then reason from facts rather than from our guess.
 */

/** ComfyUI answers a rejected upload with a JSON or text body that usually names
 *  the real reason; it is the single most useful thing here and was never read.
 *  Bounded because it lands in an agent's context, and a server that answers with
 *  an HTML error page would otherwise paste the whole document into the chat. */
const MAX_BODY_CHARS = 400;

export function clipUploadBody(text, max = MAX_BODY_CHARS) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t) return null;
  return t.length <= max ? t : `${t.slice(0, max)}… [${t.length} chars total]`;
}

/** Bytes → a short human size. Kept local and dependency-free: this string is
 *  read by a human and by an agent deciding whether to shrink the file. */
export function describeSize(bytes) {
  // null/undefined/"" must be ABSENT, not zero. Number(null) is 0 and Number("")
  // is 0, so a coerce-first check renders an unknown size as a confident "0 B" —
  // a fabricated measurement in a message whose whole purpose is to report only
  // what was observed.
  if (bytes === null || bytes === undefined || bytes === "") return null;
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The one description both upload paths use.
 *
 * `status` present  → the server answered and refused; `body` is its own words.
 * `error` present   → the request never completed (network/CORS/abort).
 * Neither           → we genuinely do not know, and say exactly that rather than
 *                     picking whichever half sounds more likely.
 */
export function describeUploadFailure({ status, statusText, body, error, name, size, mediaType } = {}) {
  const facts = [];
  if (name) facts.push(`file "${name}"`);
  const sz = describeSize(size);
  if (sz) facts.push(sz);
  if (mediaType) facts.push(mediaType);
  const measured = facts.length ? ` (${facts.join(", ")})` : "";

  const clipped = clipUploadBody(body);

  if (Number.isFinite(Number(status))) {
    const st = `HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
    // The server's own words go LAST and are labelled, so a body that itself
    // contains advice cannot be mistaken for ours.
    return (
      `upload REFUSED by ComfyUI — ${st}${measured}. Nothing was written to input/.` +
      (clipped ? ` Server said: ${clipped}` : ` The server sent no body explaining it.`)
    );
  }

  if (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return (
      `upload did not COMPLETE — the request to /upload/image threw${measured}: ${msg}. ` +
      `Whether any bytes reached the server is unknown, but no usable input/ reference came back.`
    );
  }

  return (
    `upload failed for an unobserved reason${measured} — no HTTP status and no exception were ` +
    `captured, so nothing about the cause is known. Nothing usable came back.`
  );
}

/** The chip/agent line for one attachment. Success keeps its existing shape so a
 *  reader (and the transcript) sees no change on the happy path. */
export function attachmentSummaryLine(att) {
  const token = att?.token ?? "";
  if (att?.inputRef) return `${token} → input/${att.inputRef}`;
  const why = att?.uploadError ? att.uploadError : `${att?.name ?? "attachment"} — upload failed`;
  return `${token} (${why})`;
}
