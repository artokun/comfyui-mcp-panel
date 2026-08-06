// Media-card persistence helpers (issue #177).
//
// Image/video cards are persisted as role:"media" messages so they survive a
// reload / thread switch. Only DURABLE, re-servable urls may be stored: a
// ComfyUI `/view` link or an absolute http(s) URL. Everything else is rejected
// on a POSITIVE-admission basis:
//   - `data:` URIs can be multiple MB and would blow the localStorage quota,
//     taking the whole thread down with it;
//   - `blob:` URLs are dead after a reload (object-URL lifetime is the page);
//   - any other scheme (file:, ws:, protocol-relative //host, …) is not a
//     durable panel media location.

// A generous cap so a pathological query string can't bloat the transcript, yet
// far above any real /view URL.
export const MAX_MEDIA_URL_LENGTH = 4096;
const MAX_MEDIA_CAPTION_LENGTH = 500;

/** True only for a durable, re-servable media url (absolute http(s) or a
 *  same-origin ComfyUI /view or /api/view link). Whitespace-tolerant. */
export function isDurableMediaUrl(url) {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed || trimmed.length > MAX_MEDIA_URL_LENGTH) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  // Same-origin ComfyUI view links: "/view?…" or "/api/view?…" (api.apiURL may
  // prefix the base). Requires the query so a bare "/view" directory can't slip
  // through, and the leading "/[^/]" excludes protocol-relative "//host".
  if (/^\/(?:api\/)?view\?/i.test(trimmed)) return true;
  return false;
}

/** Build the role:"media" record for a painted card, or null when it must not
 *  be persisted (currently replaying stored history, or a non-durable url).
 *  Kept pure so the admission + replay-guard logic is unit-testable. */
export function mediaRecordFor(mkind, url, caption, { replaying = false } = {}) {
  if (replaying) return null; // replay repaints; it must never re-record (would dupe every reload)
  if (!isDurableMediaUrl(url)) return null;
  const kind = mkind === "video" ? "video" : "image";
  return {
    role: "media",
    mkind: kind,
    url: url.trim(),
    caption: caption ? String(caption).slice(0, MAX_MEDIA_CAPTION_LENGTH) : "",
  };
}

/** The media persistence controller the panel actually uses (#177).
 *
 *  This owns BOTH the record decision and the replay-guard state, so the exact
 *  production logic is importable and unit-testable — not a replica. The DOM
 *  closure wires it up:
 *    - `record(rec)` is the panel's record() (append to thread + persist);
 *    - paintImage()/paintVideo() call `recorder.record(kind, url, caption)`
 *      after painting a card;
 *    - paintThread() wraps its replay loop in `recorder.replay(() => …)` so the
 *      media branch repaints WITHOUT re-recording.
 *
 *  A live paint persists exactly one durable card; a paint during replay(), or
 *  of a non-durable url, persists nothing.
 *
 *  Not unit-testable from here (verified by live-test): that paintImage/
 *  paintVideo actually call recorder.record and that paintThread wraps its loop
 *  in recorder.replay — those bindings live in the DOM closure. */
export function createMediaRecorder(record) {
  let replaying = false;
  return {
    /** True while a stored conversation is being replayed. */
    get replaying() {
      return replaying;
    },
    /** Persist a painted card if durable and not replaying. Returns the record
     *  appended, or null. */
    record(mkind, url, caption) {
      const rec = mediaRecordFor(mkind, url, caption, { replaying });
      return rec ? record(rec) : null;
    },
    /** Run `fn` (the paintThread replay loop) with the re-record guard on. */
    replay(fn) {
      replaying = true;
      try {
        return fn();
      } finally {
        replaying = false;
      }
    },
  };
}
