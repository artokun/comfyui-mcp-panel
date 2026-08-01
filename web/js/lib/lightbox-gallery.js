// In-panel media lightbox — pure, DOM-free core (issue #163).
//
// Inline chat media (images/videos painted by panel_show_media / a finished
// run) used to open in a raw new browser tab on click. #163 replaces that with
// an in-app lightbox: a full-size overlay viewer with prev/next across the
// chat's media, Esc / backdrop close, and image+video support.
//
// This module holds ONLY the logic that can be tested without a DOM:
//   - index math for prev/next (wrap or clamp),
//   - normalizing a media descriptor into { url, type, caption },
//   - deciding image-vs-video from a url when the caller didn't say,
//   - a tiny stateful model the DOM lightbox drives (index + current + step).
// The overlay DOM itself lives in comfyui-mcp-panel.js and is covered by e2e —
// mirroring how chat-media.js factors the testable core out of the paint code.

/**
 * Step an index by `delta` over a list of `len` items.
 *
 * A gallery wraps by default (prev on the first item lands on the last, and
 * vice-versa) so browsing a run of renders never dead-ends. Pass
 * `{ wrap:false }` to clamp at the ends instead. Non-finite / empty inputs
 * collapse to 0 so a caller can never index out of bounds.
 *
 * @param {number} cur   current index
 * @param {number} delta step (usually +1 / -1)
 * @param {number} len   number of items
 * @param {{wrap?:boolean}} [opts]
 * @returns {number} the next in-range index
 */
export function stepIndex(cur, delta, len, { wrap = true } = {}) {
  const n = Math.trunc(Number(len));
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Indices are array positions, so a real gallery's length is a small integer.
  // Above Number.MAX_SAFE_INTEGER (2^53-1) distinct integer indices aren't even
  // representable in a JS number, and float rounding on such magnitudes could
  // nudge a result to exactly n (out of range). There's no meaningful index to
  // land on, so collapse to 0. BELOW this bound every operation below is EXACT:
  // the residues cm,dm are in [0,n), the `cm < room` branch guarantees cm+dm < n
  // < 2^53 (representable exactly), and the else branch subtracts two values each
  // < 2^53 — so no rounding can ever push the result to n. The contract [0,n)
  // therefore holds for every finite input.
  if (n > Number.MAX_SAFE_INTEGER) return 0;
  const start = Number.isFinite(cur) ? Math.trunc(cur) : 0;
  const d = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  if (wrap) {
    // Reduce BOTH operands into [0,n). Normalize WITHOUT an unconditional `+ n`
    // (that overflows when `v % n` is already near Number.MAX_VALUE): add n only
    // when the residue is negative. Then combine with conditional subtraction
    // rather than a second `% n`: room = n - dm; cm < room ⇒ sum < n, else fold
    // via cm - room (= cm + dm - n).
    const mod = (v) => { const r = v % n; return r < 0 ? r + n : r; };
    const cm = mod(start);
    const dm = mod(d);
    const room = n - dm;
    return cm < room ? cm + dm : cm - room;
  }
  // Clamp path: start+d may be ±Infinity, which Math.min/Math.max clamp cleanly.
  return Math.max(0, Math.min(n - 1, start + d));
}

/**
 * Best-effort image-vs-video decision from a media URL when the descriptor
 * didn't carry an explicit `type`. Mirrors the panel's isVideoOutput: honour a
 * `data:video/…` / `data:image/…` MIME first, else fall back to the file
 * extension. `data:image/gif` stays an image (animated gifs render in <img>).
 *
 * @param {string} url
 * @returns {"image"|"video"}
 */
export function mediaKindFromUrl(url) {
  const s = String(url || "");
  const dm = /^data:([a-z]+)\//i.exec(s);
  if (dm) return dm[1].toLowerCase() === "video" ? "video" : "image";
  // A video extension anywhere, bounded by end-of-string or a query/fragment
  // separator. ComfyUI serves media as /view?filename=clip.webm&type=output, so
  // the extension lives in the QUERY, not at the end — don't anchor on `$` only.
  return /\.(mp4|webm|mov|mkv|m4v|avi)(?:$|[?&#])/i.test(s) ? "video" : "image";
}

/**
 * Normalize a loose media descriptor into a stable lightbox item.
 * Accepts a bare url string or `{ url, type, caption }`. An explicit `type` of
 * "video" wins; anything else (including a missing type) is resolved from the
 * url. Returns null when there is no usable url, so callers can filter.
 *
 * @param {string|{url?:string,type?:string,caption?:string}} item
 * @returns {{url:string,type:"image"|"video",caption:string}|null}
 */
export function normalizeMediaItem(item) {
  const raw = typeof item === "string" ? { url: item } : (item || {});
  const url = typeof raw.url === "string" ? raw.url : "";
  if (!url) return null;
  const declared = String(raw.type || "").toLowerCase();
  const type =
    declared === "video" ? "video" : declared === "image" ? "image" : mediaKindFromUrl(url);
  const caption = raw.caption == null ? "" : String(raw.caption);
  return { url, type, caption };
}

/**
 * A stateful, DOM-free lightbox model the overlay drives. Holds the normalized
 * gallery and the current index; `step(±1)` moves (wrapping) and returns the
 * new current item. Filters out descriptors with no url up front, so `current()`
 * always yields a renderable item (or null when the gallery is empty).
 *
 * @param {Array} items       raw descriptors
 * @param {number} [startIndex]
 * @param {{wrap?:boolean}} [opts]
 */
export function createLightboxModel(items, startIndex = 0, { wrap = true } = {}) {
  const list = (Array.isArray(items) ? items : [])
    .map(normalizeMediaItem)
    .filter(Boolean);
  let idx = list.length ? stepIndex(startIndex, 0, list.length, { wrap: false }) : 0;
  return {
    get length() {
      return list.length;
    },
    get index() {
      return idx;
    },
    items() {
      return list.slice();
    },
    current() {
      return list[idx] || null;
    },
    hasMultiple() {
      return list.length > 1;
    },
    /** Move by `delta` (wrapping unless the model was built with wrap:false). */
    step(delta) {
      if (!list.length) return null;
      idx = stepIndex(idx, delta, list.length, { wrap });
      return list[idx] || null;
    },
    /** Jump to an absolute index (clamped). */
    goto(i) {
      if (!list.length) return null;
      idx = stepIndex(i, 0, list.length, { wrap: false });
      return list[idx] || null;
    },
  };
}
